import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { Adapter, AdapterContext } from "./adapter";
import { FakeAdapter } from "./adapters/fake";
import { readGlobalConfig, readInstructions, readRepoGates, readRepoSecretNames } from "./config";
import type { GlobalConfig } from "./config";
import { assertDockerReachable, ensureBaseImage, removeRunSandboxes, startSandbox } from "./docker";
import type { Sandbox } from "./docker";
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
  scanCommitsForWarnings,
  tagExists,
} from "./git";
import { crisolHome, runDir, runLockPath, runLogPath, runRepoPath, runResultPath, runsRoot } from "./paths";
import { KeychainSecretStore } from "./secret-store";
import type { SecretStore } from "./secret-store";
import { acquireSlot, tryLockRun } from "./slots";
import type { HeldLock } from "./slots";

export type { Gate } from "./gates";

export type RunStatus = "verified" | "unverified" | "not-converged";
export type NetworkMode = "allowlist" | "learn" | "open";

const DEFAULT_BRANCH_PREFIX = "crisol";

const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_CEILING_MS = 60 * 60 * 1000;

const DEFAULT_MAX_PARALLEL = 3;

export function resolveMaxParallel(globalConfig: GlobalConfig): number {
  return globalConfig.maxParallel ?? DEFAULT_MAX_PARALLEL;
}

/** Per Run beats `~/.crisol/config` beats the default, each knob on its own. */
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
 * Fields are only ever added, never renamed or removed, within 0.x. `reason` is set only for
 * `not-converged`.
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
  /** Whether Fetch-back brought the branch into the host repo. `false` leaves it to `crisol recover`. */
  fetchBack: boolean;
}

/** What the Run lock file holds, for `crisol recover` to find a dead Run's branch and host repo. */
export interface RunLockRecord {
  host: string;
  branch: string;
}

export interface RunOptions {
  task: string;
  /** Where to discover the host git repo from — normally `process.cwd()`. */
  cwd: string;
  base?: string;
  /** Pins the commit `base` names, so a fan-out cuts every Run from one commit even if the ref moves meanwhile. */
  baseSha?: string;
  name?: string;
  /** Overrides `crisolHome()`. */
  home?: string;
  /** Defaults to `FakeAdapter`. */
  adapter?: Adapter;
  /** Test seam: forces a run-id collision. */
  generateRunId?: () => string;
  /** Test seam: a real `docker build` cannot be made to fail on demand. */
  ensureImage?: () => Promise<string>;
  /** `--gate`; absent or empty falls through to the repo's Gates. */
  gates?: readonly string[];
  maxIterations?: number;
  /** In ms. */
  ceilingMs?: number;
  /** Defaults to the login Keychain, which a test must never touch. */
  secretStore?: SecretStore;
  /** Called once if every Slot is taken and the Run starts waiting for one. */
  onSlotWait?: (maxParallel: number) => void;
  /** Called with each warning the human must act on now, such as a Sandbox left running. */
  onWarning?: (warning: string) => void;
  /**
   * Aborts a Run still waiting for a Slot. A Run past its Slot stops on its own signal handlers,
   * and treats a signal already aborted, with the signal's name as `reason`, as one received.
   */
  signal?: AbortSignal;
}

function generateRunId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function appendLog(logPath: string, line: string): void {
  appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EEXIST";
}

interface Reservation {
  id: string;
  branch: string;
  lock: HeldLock;
}

/**
 * The record is written only once the lock is held, and `crisol recover` skips a lock with no
 * record, so recover never takes the lock of a Run still being reserved.
 */
function lockRun(id: string, home: string, record: RunLockRecord): HeldLock {
  const lockPath = runLockPath(id, home);
  const lock = tryLockRun(lockPath);
  if (!lock) throw new Error(`Run ${id}'s lock is already held by another process.`);
  writeFileSync(lockPath, JSON.stringify(record));
  return lock;
}

/**
 * `mkdir` without `recursive`, so an existing Run dir is never reused and truncated; a collision
 * retries with a fresh id, as does a colliding default branch. A plain branch named `crisol`
 * collides with every id, so `assertDefaultPrefixAvailable` refuses it before this loop.
 */
function reserveRun(
  hostRepoPath: string,
  home: string,
  explicitName: string | undefined,
  generateId: () => string,
  maxAttempts = 20,
): Reservation {
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
      continue;
    }
    try {
      mkdirSync(runDir(id, home));
    } catch (error) {
      if (!isEexist(error)) throw error;
      continue;
    }
    return { id, branch, lock: lockRun(id, home, { host: hostRepoPath, branch }) };
  }
  throw new Error(`Could not allocate a unique run id after ${maxAttempts} attempts.`);
}

function assertDefaultPrefixAvailable(hostRepoPath: string): void {
  if (branchExists(hostRepoPath, DEFAULT_BRANCH_PREFIX)) {
    throw new Error(
      `A branch named "${DEFAULT_BRANCH_PREFIX}" already exists in ${hostRepoPath}; it would ` +
        `collide with every default-named Run's branch ("${DEFAULT_BRANCH_PREFIX}/<id>"). Pass ` +
        `--name to choose an explicit branch name.`,
    );
  }
}

/** Without it, an unreachable sha fails deep inside `checkoutNewBranch` with git's misleading "is not a commit". */
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

/** A `refs/` name would be double-qualified once Fetch-back prefixes `refs/heads/`. */
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

function assertDeclaredSecretsPresent(names: readonly string[]): void {
  const missing = names.filter((name) => process.env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Declared secret${missing.length > 1 ? "s" : ""} missing from the host environment: ` +
        `${missing.join(", ")}. Export ${missing.length > 1 ? "them" : "it"} before running \`crisol run\`.`,
    );
  }
}

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

const INTERRUPTING_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

interface Interruption {
  /** The first signal received, if any. */
  readonly by: string | undefined;
  /** Rejects on the first signal. */
  readonly rejected: Promise<never>;
  throwIfInterrupted(): void;
  disarm(): void;
}

function interruptedError(by: string): Error {
  return new Error(`Run interrupted by ${by}`);
}

/**
 * Armed as soon as the Run has a dir, and held through teardown and Fetch-back. A later signal
 * is logged and otherwise ignored: Crisol never abandons a teardown half way. SIGKILL remains
 * for that, and `crisol recover` for what it leaves behind.
 */
function armInterruption(logPath: string, alreadyAborted: AbortSignal | undefined): Interruption {
  let by: string | undefined;
  let reject!: (error: Error) => void;
  const rejected = new Promise<never>((_, rejectWith) => {
    reject = rejectWith;
  });
  // A signal can land before anything races this promise.
  rejected.catch(() => {});

  const onSignal = (signal: string) => {
    appendLog(logPath, `received ${signal}; tearing the Sandbox down, Fetch-back still runs`);
    if (by !== undefined) return;
    by = signal;
    reject(interruptedError(signal));
  };
  for (const signal of INTERRUPTING_SIGNALS) process.on(signal, onSignal);
  // The signal reached the caller's handler while this Run was leaving the Slot queue.
  if (alreadyAborted?.aborted) {
    onSignal(typeof alreadyAborted.reason === "string" ? alreadyAborted.reason : "abort");
  }

  return {
    get by() {
      return by;
    },
    rejected,
    throwIfInterrupted() {
      if (by !== undefined) throw interruptedError(by);
    },
    disarm() {
      for (const signal of INTERRUPTING_SIGNALS) process.off(signal, onSignal);
    },
  };
}

/** A signal that lands during a synchronous git call reaches its handler only once the event loop turns. */
function letSignalsLand(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Removes the Sandbox, retrying by label when its handle fails or never came back. Never
 * throws; returns a warning when the container is still there.
 */
async function tearDown(sandbox: Sandbox | undefined, id: string, logPath: string): Promise<string | undefined> {
  if (sandbox) {
    const stopped = await sandbox.stop();
    if (stopped.ok) {
      appendLog(logPath, `sandbox ${sandbox.containerId} stopped`);
      return undefined;
    }
    appendLog(logPath, `sandbox ${sandbox.containerId} FAILED to stop: ${stopped.stderr}; retrying by label`);
  }
  const removed = await removeRunSandboxes(id);
  if (removed.ok) {
    if (removed.removed > 0) appendLog(logPath, `sandbox removed by label crisol.run=${id}`);
    return undefined;
  }
  appendLog(logPath, `sandbox removal by label crisol.run=${id} FAILED: ${removed.stderr}`);
  return (
    `Sandbox crisol-${id} could not be removed (${removed.stderr || "docker failed"}); ` +
    `remove it with \`docker rm -f crisol-${id}\`.`
  );
}

/**
 * Crisol, never the agent, decides done: every declared Gate runs, a red one resumes the same
 * session with its failure, until all are green or the ceiling hits. With no Gate anywhere, the
 * agent's completion report stands in. Fetch-back runs on every exit, whatever `status` is.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const home = options.home ?? crisolHome();
  const hostRepoPath = discoverGitRoot(options.cwd);
  if (!hostRepoPath) {
    throw new Error(`Not inside a git repo: ${options.cwd}`);
  }

  // Every validation below runs BEFORE any side effect — no mkdir, no clone, no docker run.
  const identity = readIdentity(hostRepoPath);
  const instructions = readInstructions(home);

  const baseRef = options.base ?? currentRefName(hostRepoPath);
  const baseSha = options.baseSha ?? resolveBaseSha(hostRepoPath, baseRef);
  assertBaseReachable(hostRepoPath, baseRef, baseSha);
  const base = `${baseRef}@${baseSha}`;

  if (options.name !== undefined) {
    assertBranchAvailable(hostRepoPath, options.name);
  } else {
    assertDefaultPrefixAvailable(hostRepoPath);
  }

  const gates = resolveGates(options.gates, readRepoGates(hostRepoPath));
  const globalConfig = readGlobalConfig(home);
  const maxParallel = resolveMaxParallel(globalConfig);
  const { maxIterations, ceilingMs } = resolveCeiling(
    { maxIterations: options.maxIterations, ceilingMs: options.ceilingMs },
    globalConfig,
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

  const ensureImage = options.ensureImage ?? preStart.ensureImage ?? ensureBaseImage;
  // An offline first Run must fail here, never after leaving a Clone and a branch behind.
  const image = await ensureImage();

  // Before the Run reserves anything, so a queued Run leaves no trace on disk.
  const slot = await acquireSlot({
    home,
    maxParallel,
    onWait: () => options.onSlotWait?.(maxParallel),
    signal: options.signal,
  });

  let reservation: Reservation | undefined;
  try {
    reservation = reserveRun(hostRepoPath, home, options.name, options.generateRunId ?? generateRunId);
    writeFileSync(runLogPath(reservation.id, home), "");
  } catch (error) {
    reservation?.lock.release();
    slot.release();
    throw error;
  }
  const { id, branch, lock } = reservation;
  const logPath = runLogPath(id, home);
  const clonePath = runRepoPath(id, home);
  const interruption = armInterruption(logPath, options.signal);

  appendLog(
    logPath,
    `run ${id} starting: task=${JSON.stringify(options.task)} base=${base} branch=${branch} ` +
      `slot=${slot.index}/${maxParallel}`,
  );

  let iterations = 0;
  let status: RunStatus = "unverified";
  let reason: string | undefined;
  let gateResults: Gate[] = [];
  const warnings: string[] = [];
  let primaryError: unknown;
  let fetchBackError: unknown;
  let resultError: unknown;
  let fetchedBack = false;
  let sandbox: Sandbox | undefined;

  const converge = async (ctx: AdapterContext): Promise<void> => {
    await adapter.launch(ctx);
    iterations = 1;
    const startedAt = Date.now();

    while (true) {
      // The race below has already moved on; this keeps an interrupted loop from resuming the agent.
      interruption.throwIfInterrupted();
      const completed = await adapter.reportCompletion(ctx);
      appendLog(logPath, `adapter reported completion=${completed} after ${iterations} iteration(s)`);

      if (gates.length === 0) {
        status = "unverified";
        gateResults = [];
        return;
      }

      const { results, firstFailure } = await runGates(ctx.sandbox, gates);
      interruption.throwIfInterrupted();
      gateResults = results;
      appendLog(
        logPath,
        `gates (iteration ${iterations}): ${results
          .map((gate) => `${gate.cmd} => ${gate.ok ? "ok" : "FAIL"}`)
          .join("; ")}`,
      );

      if (firstFailure === undefined) {
        status = "verified";
        return;
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
        return;
      }

      appendLog(logPath, `resuming with feedback for failing Gate "${firstFailure.cmd}"`);
      await adapter.resumeWithFeedback(ctx, formatGateFeedback(firstFailure));
      iterations += 1;
    }
  };

  try {
    try {
      // Made even when a signal already landed: an interrupted Run still leaves its branch.
      cloneLocal(hostRepoPath, clonePath);
      checkoutNewBranch(clonePath, branch, baseSha);
      appendLog(logPath, `clone ready at ${clonePath}, branch ${branch} cut from ${baseSha}`);
      await letSignalsLand();
      interruption.throwIfInterrupted();

      sandbox = await startSandbox({
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

      await Promise.race([
        converge({ sandbox, repoPath: clonePath, task: options.task, instructions }),
        interruption.rejected,
      ]);

      // Best-effort: a failed scan must not turn a converged Run into a failed one.
      try {
        warnings.push(...scanCommitsForWarnings(clonePath, `${baseSha}..${branch}`, identity));
      } catch (error) {
        appendLog(logPath, `commit scan failed: ${errorMessage(error)}`);
      }
    } catch (error) {
      primaryError = error;
      appendLog(logPath, `primary error: ${errorMessage(error)}`);
    }

    const teardownWarning = await tearDown(sandbox, id, logPath);
    if (teardownWarning !== undefined) {
      warnings.push(teardownWarning);
      options.onWarning?.(teardownWarning);
    }

    try {
      fetchBack(hostRepoPath, clonePath, branch, (signal) =>
        appendLog(logPath, `fetch-back killed by ${signal}; retrying`),
      );
      fetchedBack = true;
      appendLog(logPath, `fetch-back complete: ${branch} now in ${hostRepoPath}`);
    } catch (error) {
      fetchBackError = error;
      appendLog(logPath, `fetch-back failed: ${errorMessage(error)}`);
    }
    await letSignalsLand();

    if (primaryError !== undefined) {
      status = "not-converged";
      reason = interruption.by !== undefined ? `interrupted: ${interruption.by}` : `error: ${errorMessage(primaryError)}`;
    }
    const result: RunResult = {
      run: id,
      branch,
      base,
      status,
      ...(reason !== undefined ? { reason } : {}),
      iterations,
      gates: gateResults,
      network: "open", // no Allowlist wall yet
      blocked: [],
      warnings,
      fetchBack: fetchedBack,
    };

    // Written on every exit, before the Run lock frees: recover and gc read it as the Run's last word.
    try {
      writeFileSync(runResultPath(id, home), JSON.stringify(result, null, 2));
      appendLog(logPath, `result written: ${JSON.stringify(result)}`);
    } catch (error) {
      resultError = error;
      appendLog(logPath, `result.json could not be written: ${errorMessage(error)}`);
    }

    const errors = [primaryError, fetchBackError].filter((error) => error !== undefined);
    if (errors.length === 2) {
      throw new AggregateError(errors, "Run failed and Fetch-back also failed");
    }
    if (errors.length === 1) throw errors[0];
    if (resultError !== undefined) throw resultError;
    return result;
  } finally {
    interruption.disarm();
    lock.release();
    slot.release();
  }
}

/**
 * Independent Runs, one per Task, all cut from the commit `base` names at the moment of the
 * call — never chained, never merged. Each settles on its own, so one failing Run never
 * hides the others' branches.
 */
export async function runFanOut(
  tasks: readonly string[],
  options: Omit<RunOptions, "task" | "name" | "baseSha">,
): Promise<PromiseSettledResult<RunResult>[]> {
  const hostRepoPath = discoverGitRoot(options.cwd);
  if (!hostRepoPath) {
    throw new Error(`Not inside a git repo: ${options.cwd}`);
  }
  const base = options.base ?? currentRefName(hostRepoPath);
  const baseSha = resolveBaseSha(hostRepoPath, base);
  return Promise.allSettled(tasks.map((task) => run({ ...options, task, base, baseSha })));
}
