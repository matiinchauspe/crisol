import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { Adapter } from "./adapter";
import { FakeAdapter } from "./adapters/fake";
import { readGlobalConfig, readRepoGates, readRepoSecretNames } from "./config";
import type { GlobalConfig } from "./config";
import { assertDockerReachable, ensureBaseImage, startSandbox } from "./docker";
import { formatGateFeedback, resolveGates, runGates } from "./gates";
import type { Gate } from "./gates";
import {
  branchExists,
  checkoutNewBranch,
  cloneLocal,
  currentRefName,
  discoverGitRoot,
  fetchBack,
  hasPrefixCollision,
  isReachableFromClonedRefs,
  isValidBranchName,
  readIdentity,
  resolveBaseSha,
  tagExists,
} from "./git";
import { crisolHome, runDir, runLogPath, runRepoPath, runResultPath, runsRoot } from "./paths";
import { KeychainSecretStore } from "./secret-store";
import type { SecretStore } from "./secret-store";

export type { Gate } from "./gates";

export type RunStatus = "verified" | "unverified" | "not-converged";
export type NetworkMode = "allowlist" | "learn" | "open";

/** Named once so the upfront guard and `reserveRun` agree on exactly what they're protecting. */
const DEFAULT_BRANCH_PREFIX = "crisol";

/** 5 iterations OR 60 minutes, whichever comes first — see `resolveCeiling` for the override ladder. */
const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_CEILING_MS = 60 * 60 * 1000;

/**
 * Same ladder shape as `resolveGates`: per-Run beats `~/.crisol/config` beats the
 * built-in default, resolved independently per knob. Kept as a pure function so the
 * precedence itself is a unit test and never needs a real Sandbox.
 */
export function resolveCeiling(
  perRun: { maxIterations?: number; ceilingMs?: number },
  globalConfig: GlobalConfig,
  defaults: { maxIterations: number; ceilingMs: number },
): { maxIterations: number; ceilingMs: number } {
  const configCeilingMs =
    globalConfig.timeoutMinutes !== undefined ? globalConfig.timeoutMinutes * 60 * 1000 : undefined;
  return {
    maxIterations: perRun.maxIterations ?? globalConfig.maxIterations ?? defaults.maxIterations,
    ceilingMs: perRun.ceilingMs ?? configCeilingMs ?? defaults.ceilingMs,
  };
}

export interface Blocked {
  host: string;
  count: number;
}

/**
 * Fields are only ever added, never renamed or removed, within 0.x. `status` is
 * `"unverified"` only when no Gate exists anywhere in the ladder; `"verified"` and
 * `"not-converged"` are driven by the Gate loop in `run()` below, and `reason` is set
 * only for the latter.
 */
export interface RunResult {
  run: string;
  branch: string;
  base: string;
  status: RunStatus;
  reason?: string;
  iterations: number;
  gates: Gate[];
  network: NetworkMode;
  blocked: Blocked[];
  warnings: string[];
}

export interface RunOptions {
  task: string;
  /** Where to discover the host git repo from — normally `process.cwd()`. */
  cwd: string;
  base?: string;
  name?: string;
  /** Overrides `crisolHome()` — the test seam (each test gets its own temp CRISOL_HOME). */
  home?: string;
  /** Overrides the default `FakeAdapter` — the test seam for a scripted scenario; v1 has no other Adapter. */
  adapter?: Adapter;
  /** Overrides the real id generator — the test seam for forcing a run-id collision. */
  generateRunId?: () => string;
  /**
   * Overrides `ensureBaseImage` — the test seam for forcing an image-resolution failure.
   * Forcing a REAL `docker build` to fail deterministically isn't practical in a test;
   * same pattern as `generateRunId`.
   */
  ensureImage?: () => Promise<string>;
  /** `--gate` — the strongest rung of the Gate ladder; absent or empty falls through to the repo rung. */
  gates?: readonly string[];
  /** Default 5; the test seam for "never converge" and ceiling scenarios, where small numbers keep tests fast. */
  maxIterations?: number;
  /** Default 60 minutes, in ms. Same test-seam reasoning as `maxIterations` — a real wall clock would make ceiling tests impractical. */
  ceilingMs?: number;
  /** Overrides the default `KeychainSecretStore` — the test seam, since a test must never touch the real login Keychain. */
  secretStore?: SecretStore;
}

/**
 * 8 lowercase hex chars. Collisions are still possible, just astronomically unlikely
 * at this length — `reserveRun` below is what actually makes a collision SAFE, not
 * this function's output space.
 */
function generateRunId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function appendLog(logPath: string, line: string): void {
  appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EEXIST";
}

/**
 * Reserves a Run id AND its directory atomically enough to matter: `mkdir` without
 * `recursive` so an existing dir throws EEXIST instead of being silently reused (and
 * truncated) — retried with a fresh id on collision, up to `maxAttempts`. A colliding
 * DEFAULT branch (`crisol/<id>`, no explicit `--name`) also forces a retry; an explicit
 * `--name` was already validated once by the caller.
 *
 * The retry checks the SAME three collisions `assertBranchAvailable` runs for an
 * explicit `--name` (branch, tag, D/F conflict), not just `branchExists` alone. The
 * id-INDEPENDENT case — a plain branch named "crisol" blocking every possible
 * `crisol/<id>` — is NOT handled here, since no retry could ever escape it; see
 * `assertDefaultPrefixAvailable`, called once before this loop starts.
 */
function reserveRun(
  hostRepoPath: string,
  home: string,
  explicitName: string | undefined,
  generateId: () => string,
  maxAttempts = 20,
): { id: string; branch: string } {
  mkdirSync(runsRoot(home), { recursive: true });
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = generateId();
    const branch = explicitName ?? `${DEFAULT_BRANCH_PREFIX}/${id}`;
    if (
      explicitName === undefined &&
      (branchExists(hostRepoPath, branch) ||
        tagExists(hostRepoPath, branch) ||
        hasPrefixCollision(hostRepoPath, branch))
    ) {
      continue; // an extremely rare default-branch collision — try another id
    }
    try {
      mkdirSync(runDir(id, home));
      return { id, branch };
    } catch (error) {
      if (!isEexist(error)) throw error;
      // run-dir collision on this id — try another, never reuse this one.
    }
  }
  throw new Error(`Could not allocate a unique run id after ${maxAttempts} attempts.`);
}

/**
 * The id-INDEPENDENT case `reserveRun`'s own retry loop can never escape: a plain
 * branch literally named "crisol" collides with the directory/file shape of EVERY
 * possible `crisol/<id>` default branch, so every retry attempt fails the same way.
 * Checked here, before any side effect, with a plain message naming the real cause
 * instead of letting the loop exhaust `maxAttempts` on a cryptic one.
 */
function assertDefaultPrefixAvailable(hostRepoPath: string): void {
  if (branchExists(hostRepoPath, DEFAULT_BRANCH_PREFIX)) {
    throw new Error(
      `A branch named "${DEFAULT_BRANCH_PREFIX}" already exists in ${hostRepoPath}; it would ` +
        `collide with every default-named Run's branch ("${DEFAULT_BRANCH_PREFIX}/<id>"). Pass ` +
        `--name to choose an explicit branch name.`,
    );
  }
}

/**
 * `resolveBaseSha` only proves `sha` EXISTS, not that it's reachable from anything — an
 * unreachable sha used to pass silently here, only to fail deep inside `checkoutNewBranch`
 * with git's own misleading "is not a commit". Checked here, before any side effect, with
 * a plain message naming the sha and the way out (fast-forward a local branch onto it).
 */
function assertBaseReachable(hostRepoPath: string, baseRef: string, baseSha: string): void {
  if (!isReachableFromClonedRefs(hostRepoPath, baseSha)) {
    throw new Error(
      `"${baseRef}" resolved to ${baseSha}, which exists in ${hostRepoPath} but isn't reachable ` +
        `from a local branch, a tag, or HEAD (it may be a remote-tracking ref, a stash entry, or a ` +
        `force-deleted/rewritten commit) — the Clone only ever receives objects reachable from those ` +
        `three. Check out or fast-forward a local branch onto ${baseSha}, then pass that branch as --base.`,
    );
  }
}

/**
 * All checks run before any side effect. A name starting with `refs/` would
 * double-qualify once `fetchBack` prefixes `refs/heads/` onto it; the tag-ambiguity
 * and directory/file-collision checks are refused outright here too, rather than
 * relying solely on `fetchBack`'s own fully-qualified refspec to save them later.
 */
function assertBranchAvailable(hostRepoPath: string, name: string): void {
  if (!isValidBranchName(name)) {
    throw new Error(`"${name}" is not a valid git branch name.`);
  }
  if (name.startsWith("refs/")) {
    throw new Error(
      `"${name}" starts with "refs/"; pass a plain branch name, not a fully-qualified ref.`,
    );
  }
  if (branchExists(hostRepoPath, name)) {
    throw new Error(`Branch "${name}" already exists in ${hostRepoPath}; choose a different --name.`);
  }
  if (tagExists(hostRepoPath, name)) {
    throw new Error(
      `"${name}" is already a tag in ${hostRepoPath}; choose a --name that isn't ambiguous with a tag.`,
    );
  }
  if (hasPrefixCollision(hostRepoPath, name)) {
    throw new Error(
      `"${name}" conflicts with an existing branch that shares its path (a branch cannot be both ` +
        `a file and a directory in git's ref storage); choose a different --name.`,
    );
  }
}

/** A repo-declared secret's value comes from the host's own env, never the Keychain — checked before any side effect, naming whatever is missing. */
function assertDeclaredSecretsPresent(names: readonly string[]): void {
  const missing = names.filter((name) => process.env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Declared secret${missing.length > 1 ? "s" : ""} missing from the host environment: ` +
        `${missing.join(", ")}. Export ${missing.length > 1 ? "them" : "it"} before running \`crisol run\`.`,
    );
  }
}

/** An Adapter-declared secret's value comes from `SecretStore`, keyed by that same name — never a special case for one literal name. Checked before any side effect; a name `crisol auth` never populated fails the Run, naming it. */
function resolveAdapterSecretValues(
  secretStore: SecretStore,
  names: readonly string[],
): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = secretStore.get(name);
    if (value === undefined) {
      missing.push(name);
    } else {
      values[name] = value;
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Secret${missing.length > 1 ? "s" : ""} not found in Crisol's Keychain entry: ` +
        `${missing.join(", ")}. Run \`crisol auth\` first.`,
    );
  }
  return values;
}

/**
 * Crisol, never the agent, decides done: the loop below runs every declared Gate,
 * resumes the SAME session with the failing command on red, and repeats until every
 * Gate is green or the ceiling hits first. With no Gate anywhere in the ladder, the
 * agent's own completion report stands in. Fetch-back runs always, whatever `status`
 * landed on.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const home = options.home ?? crisolHome();
  const hostRepoPath = discoverGitRoot(options.cwd);
  if (!hostRepoPath) {
    throw new Error(`Not inside a git repo: ${options.cwd}`);
  }

  // Every validation below runs BEFORE any side effect — no mkdir, no clone, no docker run.
  const identity = readIdentity(hostRepoPath);

  const baseRef = options.base ?? currentRefName(hostRepoPath);
  const baseSha = resolveBaseSha(hostRepoPath, baseRef);
  assertBaseReachable(hostRepoPath, baseRef, baseSha);
  const base = `${baseRef}@${baseSha}`;

  if (options.name !== undefined) {
    assertBranchAvailable(hostRepoPath, options.name);
  } else {
    assertDefaultPrefixAvailable(hostRepoPath);
  }

  // Grouped with every other pre-flight check, before Docker or any side effect.
  const gates = resolveGates(options.gates, readRepoGates(hostRepoPath));
  const { maxIterations, ceilingMs } = resolveCeiling(
    { maxIterations: options.maxIterations, ceilingMs: options.ceilingMs },
    readGlobalConfig(home),
    { maxIterations: DEFAULT_MAX_ITERATIONS, ceilingMs: DEFAULT_CEILING_MS },
  );

  const repoSecretNames = readRepoSecretNames(hostRepoPath);
  assertDeclaredSecretsPresent(repoSecretNames);

  assertDockerReachable();

  const adapter = options.adapter ?? new FakeAdapter();
  const preStart = adapter.declarePreStart();
  const secretStore = options.secretStore ?? new KeychainSecretStore();
  const adapterSecretValues = resolveAdapterSecretValues(secretStore, preStart.envNames);
  const secretEnvNames = Array.from(new Set([...preStart.envNames, ...repoSecretNames]));

  const ensureImage = options.ensureImage ?? ensureBaseImage;
  // Resolved BEFORE any side effect — an offline first Run must throw here, never
  // leave a Clone+cut branch behind.
  const image = await ensureImage();

  const generateId = options.generateRunId ?? generateRunId;
  const { id, branch } = reserveRun(hostRepoPath, home, options.name, generateId);

  const logPath = runLogPath(id, home);
  const clonePath = runRepoPath(id, home);
  writeFileSync(logPath, "");

  appendLog(
    logPath,
    `run ${id} starting: task=${JSON.stringify(options.task)} base=${base} branch=${branch}`,
  );

  let iterations = 0;
  let status: RunStatus = "unverified";
  let reason: string | undefined;
  let gateResults: Gate[] = [];
  let primaryError: unknown;
  let fetchBackError: unknown;
  /**
   * Must cover the WHOLE window from the Sandbox starting through teardown AND
   * Fetch-back — armed after `startSandbox` succeeds, disarmed once in the outer
   * `finally` AFTER Fetch-back. The OLD code removed the handlers right after the
   * Adapter's race settled, well before `stop()`/Fetch-back ran, so a Ctrl+C landing
   * there was silently lost. A second signal during teardown/Fetch-back is logged but
   * a no-op — Crisol never force-exits itself mid-teardown; SIGKILL remains for that.
   */
  let interruptHandler: ((signal: NodeJS.Signals) => void) | undefined;

  try {
    try {
      // Moved inside the SAME try as every failure below, so a Clone/checkout failure is
      // logged exactly like any other primary error, and Fetch-back still gets its own
      // attempt even though, with no branch cut, it will usually fail too.
      cloneLocal(hostRepoPath, clonePath);
      checkoutNewBranch(clonePath, branch, baseSha);
      appendLog(logPath, `clone ready at ${clonePath}, branch ${branch} cut from ${baseSha}`);

      const sandbox = await startSandbox({
        image,
        mountPath: clonePath,
        env: {
          GIT_AUTHOR_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_COMMITTER_NAME: identity.name,
          GIT_COMMITTER_EMAIL: identity.email,
        },
        secretEnvNames,
        secretEnv: adapterSecretValues,
        mounts: preStart.mounts,
        id,
      });
      appendLog(
        logPath,
        `sandbox ${sandbox.containerId} started from ${image}, mounts=${sandbox.mounts.join(",")}`,
      );

      // Racing the Adapter's work against an "interrupted" promise, and letting the
      // signal REJECT it, reuses the primaryError/finally machinery below exactly as an
      // ordinary Adapter failure would — the Sandbox still gets torn down, and
      // Fetch-back still runs.
      let onInterrupt!: (signal: NodeJS.Signals) => void;
      const interrupted = new Promise<never>((_, reject) => {
        onInterrupt = (signal) => {
          appendLog(logPath, `received ${signal}; tearing the Sandbox down, Fetch-back still runs`);
          reject(new Error(`Run interrupted by ${signal}`));
        };
      });
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onInterrupt);
      interruptHandler = onInterrupt; // removed once, in the outer `finally`

      try {
        const ctx = { sandbox, repoPath: clonePath, task: options.task };
        await Promise.race([
          (async () => {
            await adapter.launch(ctx);
            iterations = 1;
            const startedAt = Date.now();

            while (true) {
              const completed = await adapter.reportCompletion(ctx);
              appendLog(
                logPath,
                `adapter reported completion=${completed} after ${iterations} iteration(s)`,
              );

              if (gates.length === 0) {
                status = "unverified";
                gateResults = [];
                break;
              }

              const { results, firstFailure } = await runGates(sandbox, gates);
              gateResults = results;
              appendLog(
                logPath,
                `gates (iteration ${iterations}): ${results
                  .map((gate) => `${gate.cmd} => ${gate.ok ? "ok" : "FAIL"}`)
                  .join("; ")}`,
              );

              if (firstFailure === undefined) {
                status = "verified";
                break;
              }

              const elapsedMs = Date.now() - startedAt;
              if (iterations >= maxIterations || elapsedMs >= ceilingMs) {
                status = "not-converged";
                reason = "ceiling";
                appendLog(
                  logPath,
                  `ceiling reached at iteration ${iterations} (elapsed ${elapsedMs}ms); ` +
                    `last failing Gate "${firstFailure.cmd}": ${firstFailure.output}`,
                );
                break;
              }

              appendLog(logPath, `resuming with feedback for failing Gate "${firstFailure.cmd}"`);
              await adapter.resumeWithFeedback(ctx, formatGateFeedback(firstFailure));
              iterations += 1;
            }
          })(),
          interrupted,
        ]);
      } finally {
        const stopResult = await sandbox.stop();
        if (stopResult.ok) {
          appendLog(logPath, `sandbox ${sandbox.containerId} stopped`);
        } else {
          appendLog(
            logPath,
            `sandbox ${sandbox.containerId} FAILED to stop: ${stopResult.stderr}`,
          );
        }
      }
    } catch (error) {
      primaryError = error;
      appendLog(
        logPath,
        `primary error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Fetch-back is never optional — it runs even when the step above failed, and its own
    // failure is logged but never masks the primary error. Still inside the signal-covered
    // window: `interruptHandler` is removed only once, after this attempt.
    try {
      fetchBack(hostRepoPath, clonePath, branch);
      appendLog(logPath, `fetch-back complete: ${branch} now in ${hostRepoPath}`);
    } catch (error) {
      fetchBackError = error;
      appendLog(
        logPath,
        `fetch-back failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    if (interruptHandler) {
      process.off("SIGINT", interruptHandler);
      process.off("SIGTERM", interruptHandler);
    }
  }

  if (primaryError !== undefined && fetchBackError !== undefined) {
    throw new AggregateError(
      [primaryError, fetchBackError],
      "Run failed and Fetch-back also failed",
    );
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
  if (fetchBackError !== undefined) {
    throw fetchBackError;
  }

  const result: RunResult = {
    run: id,
    branch,
    base,
    status,
    iterations,
    gates: gateResults,
    network: "open", // no Allowlist wall yet
    blocked: [],
    warnings: [],
  };
  if (reason !== undefined) {
    result.reason = reason;
  }

  writeFileSync(runResultPath(id, home), JSON.stringify(result, null, 2));
  appendLog(logPath, `result written: ${JSON.stringify(result)}`);

  return result;
}
