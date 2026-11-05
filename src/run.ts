import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { Adapter } from "./adapter";
import { FakeAdapter } from "./adapters/fake";
import { assertDockerReachable, ensureBaseImage, startSandbox } from "./docker";
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

export type RunStatus = "verified" | "unverified" | "not-converged";
export type NetworkMode = "allowlist" | "learn" | "open";

/** The default branch prefix (`crisol/<id>`) — named once so finding 1's upfront guard and `reserveRun` agree on exactly what they're protecting. */
const DEFAULT_BRANCH_PREFIX = "crisol";

export interface Gate {
  cmd: string;
  ok: boolean;
}

export interface Blocked {
  host: string;
  count: number;
}

/**
 * The stable public shape (spec, "Input and output" q9) — fields are only
 * ever added, never renamed or removed, within 0.x. Ticket 01 only ever
 * produces `status: "unverified"` (no Gates exist yet), so `reason`
 * (meaningful only for `not-converged`) is optional and never set here.
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
  /** Overrides the real id generator — the test seam for forcing a run-id collision (fix W2). */
  generateRunId?: () => string;
  /**
   * Overrides `ensureBaseImage` — the test seam for forcing an
   * image-resolution failure (finding 5: this must happen BEFORE any side
   * effect, so an offline first Run never leaves a Clone+cut branch
   * behind). Forcing a REAL `docker build` to fail deterministically isn't
   * practical in a test; this is the same pattern as `generateRunId`.
   */
  ensureImage?: () => Promise<string>;
}

/**
 * 8 lowercase hex chars (fix W2 — lengthened from the spec's own "a1b2"
 * EXAMPLE, which was never meant as the literal id length). Collisions are
 * still possible, just astronomically unlikely at this length; `reserveRun`
 * below is what actually makes a collision SAFE, not this function's
 * output space.
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
 * Reserves a Run id AND its directory atomically enough to matter: `mkdir`
 * without `recursive` so an existing dir throws EEXIST instead of being
 * silently reused (and truncated — fix W2) — retried with a fresh id on
 * collision, up to `maxAttempts`. When the branch name is the DEFAULT
 * (`crisol/<id>`, no explicit `--name`), a colliding default branch also
 * forces a retry — an explicit `--name` was already validated once, before
 * any side effect, by the caller.
 *
 * Round-3 review, finding 1 (CRITICAL): the per-id retry check originally
 * only looked at `branchExists`, never `tagExists`/`hasPrefixCollision` —
 * extended here to the SAME three checks `assertBranchAvailable` runs for
 * an explicit `--name`, so an (astronomically rare) id-specific tag or D/F
 * collision is also retried rather than silently reaching Fetch-back. The
 * id-INDEPENDENT case — a plain branch named "crisol" blocking every
 * possible `crisol/<id>` — is NOT handled here (no retry could ever help
 * it); see `assertDefaultPrefixAvailable`, called once before this loop
 * even starts.
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
 * Round-3 review, finding 1 (CRITICAL): a default-named Run (no `--name`)
 * never ran any of `assertBranchAvailable`'s checks — only an explicit
 * `--name` did. The worst case is id-INDEPENDENT: a plain branch literally
 * named "crisol" collides with the directory/file shape of EVERY possible
 * `crisol/<id>` default branch, so `reserveRun`'s own id-retry loop can
 * never escape it (every attempt fails the same way, exhausting
 * `maxAttempts` on a cryptic "could not allocate" message instead of
 * naming the real cause). Checked once, here, before `reserveRun` is even
 * called — before any side effect — with a plain message pointing at the
 * one way out.
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
 * Round-3 review, finding 4 (WARNING): `resolveBaseSha` only proves `sha`
 * EXISTS, not that it's reachable from anything — an unreachable sha used
 * to pass silently here, through `reserveRun`'s mkdir and `cloneLocal`,
 * only to fail deep inside `checkoutNewBranch` with git's own misleading
 * "is not a commit" (git's `--no-local` transport only ever walks objects
 * reachable from a ref, so the Clone can never actually see it). Checked
 * here, before any side effect, with a plain message naming the sha.
 *
 * Round-4 review, finding C1 (WARNING, both reviewers reproduced): the
 * check itself used to look at ALL refs in the host repo
 * (`isReachableFromAnyRef`), which disagreed with what `cloneLocal`
 * actually transfers — see `isReachableFromClonedRefs`'s own doc comment
 * in `git.ts` for the full mismatch and why narrowing the check (not the
 * Clone) is the fix. The message below now also names the way out for the
 * one case that's unreachable for a GOOD reason (a remote-tracking-only or
 * stashed sha): check out or fast-forward a local branch onto it first.
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
 * All checks here run BEFORE any side effect (fix W5's own ordering),
 * extended by round-2 review findings 1 and 2:
 * - a name starting with `refs/` would double-qualify once `fetchBack`
 *   prefixes `refs/heads/` onto it (finding 1b);
 * - a name ambiguous with an existing TAG is refused outright, rather than
 *   relying solely on `fetchBack`'s own qualified refspec and post-fetch
 *   verification to save it (finding 1b, CRITICAL);
 * - a name that collides with an existing branch by ref directory/file
 *   conflict (`crisol` vs `crisol/<id>`, or the reverse) is caught HERE,
 *   never left for git to reject at Fetch-back once the whole Run already
 *   ran for nothing (finding 2).
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

/**
 * The thinnest Run end to end (ticket 01): Clone the host repo, cut a
 * branch, bind-mount the Clone into a Sandbox, let the Adapter work and
 * commit, Fetch-back, report. No Gates exist yet, so Crisol never loops —
 * `status` is always `"unverified"`.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const home = options.home ?? crisolHome();
  const hostRepoPath = discoverGitRoot(options.cwd);
  if (!hostRepoPath) {
    throw new Error(`Not inside a git repo: ${options.cwd}`);
  }

  // Fix W5: every validation below runs BEFORE any side effect — no mkdir,
  // no clone, no `docker run` — in the order the review asked for: identity,
  // base resolution, branch name, Docker reachability.
  const identity = readIdentity(hostRepoPath);

  const baseRef = options.base ?? currentRefName(hostRepoPath);
  // Resolves an annotated tag down to the commit it targets (fix "tag").
  const baseSha = resolveBaseSha(hostRepoPath, baseRef);
  assertBaseReachable(hostRepoPath, baseRef, baseSha); // finding 4
  const base = `${baseRef}@${baseSha}`;

  if (options.name !== undefined) {
    assertBranchAvailable(hostRepoPath, options.name); // fix W3, findings 1b/2
  } else {
    assertDefaultPrefixAvailable(hostRepoPath); // finding 1 (round-3 review, CRITICAL)
  }

  assertDockerReachable();

  const adapter = options.adapter ?? new FakeAdapter();
  // Adapter-split fix: authenticate/wireHooks now arrive as ONE pre-start
  // declaration, consumed by `startSandbox` before it ever runs `docker
  // run` — see docs/adr/0005-pre-start-declaration-replaces-post-start-wiring.md.
  const preStart = adapter.declarePreStart();
  const ensureImage = options.ensureImage ?? ensureBaseImage;
  // Finding 5: resolved/built BEFORE any side effect (mkdir, clone, branch
  // cut) — an offline first Run (image build fails) must throw here, never
  // leave a Clone+cut branch behind for Fetch-back to bring back empty.
  const image = await ensureImage();

  const generateId = options.generateRunId ?? generateRunId;
  const { id, branch } = reserveRun(hostRepoPath, home, options.name, generateId); // fix W2

  const logPath = runLogPath(id, home);
  const clonePath = runRepoPath(id, home);
  writeFileSync(logPath, "");

  appendLog(
    logPath,
    `run ${id} starting: task=${JSON.stringify(options.task)} base=${base} branch=${branch}`,
  );

  let iterations = 0;
  let primaryError: unknown;
  let fetchBackError: unknown;
  // Finding 2 (round-3 review, CRITICAL): SIGINT/SIGTERM must cover the
  // WHOLE window from the Sandbox starting through teardown AND
  // Fetch-back — armed right after `startSandbox` succeeds (below) and
  // disarmed exactly once, in the outer `finally` at the bottom of this
  // block, AFTER Fetch-back has been attempted. The OLD code `process.off`'d
  // the handlers right after the Adapter's own race settled — well before
  // `sandbox.stop()` or Fetch-back ever ran — so a Ctrl+C landing in either
  // of those windows hit no listener at all: silently lost, no log line, no
  // effect. A SECOND signal arriving once teardown/Fetch-back is already
  // underway is still logged here, but is otherwise a no-op: `interrupted`
  // (below) can only reject once, and Crisol never force-exits itself
  // mid-teardown or mid-Fetch-back — that is exactly the failure this fix
  // closes. An operator who truly wants an immediate exit still has SIGKILL.
  let interruptHandler: ((signal: NodeJS.Signals) => void) | undefined;

  try {
    try {
      // The Clone gets its OWN .git, with ONLY the objects reachable from
      // some ref — see docs/adr/0004-clone-copies-objects-no-hardlinks.md
      // (fix C1, amended by finding 9) — cut here, before the Sandbox even
      // exists, so the agent never has a moment where it could reach the
      // host's refs.
      //
      // Finding 5 (round-3 review, CONFIRMED): this used to run OUTSIDE any
      // try/catch, so a Clone/checkout failure propagated straight out of
      // `run()` with the Run log left holding only the "starting" line.
      // Moved inside the SAME try as every failure below, so it is logged
      // exactly like any other primary error, and Fetch-back still gets
      // its own attempt (fix W4) even though, with no branch ever cut,
      // that attempt will usually fail too.
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
        secretEnvNames: preStart.envNames,
        mounts: preStart.mounts,
        id,
      });
      appendLog(
        logPath,
        `sandbox ${sandbox.containerId} started from ${image}, mounts=${sandbox.mounts.join(",")}`,
      );

      // Finding 6: Ctrl+C (SIGINT) or SIGTERM must tear the Sandbox down
      // AND still run Fetch-back (spec: "On EVERY exit ... Ctrl+C") rather
      // than leaving the container and the agent running. Racing the
      // Adapter's own work against an "interrupted" promise, and letting
      // the signal REJECT it, reuses the primaryError/finally machinery
      // below exactly as an ordinary Adapter failure would — the Sandbox
      // still gets torn down in `finally`, and Fetch-back still runs after.
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
            iterations += 1;
            const done = await adapter.reportCompletion(ctx);
            appendLog(logPath, `adapter reported completion=${done} after ${iterations} iteration(s)`);
          })(),
          interrupted,
        ]);
      } finally {
        // Fix W1: `stop()` now reports whether teardown actually succeeded —
        // never claim "stopped" when it didn't.
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

    // Fix W4: Fetch-back is never optional (spec, "Workspace") — it runs even
    // when the step above failed, and ITS OWN failure is logged but never
    // masks the primary error. Still inside the signal-covered window
    // (finding 2): `interruptHandler`, if armed, is removed only once, in
    // the outer `finally` below, AFTER this attempt.
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
    status: "unverified", // no Gates yet — see docs/adr/0002-...
    iterations,
    gates: [],
    network: "open", // no Allowlist wall yet — see docs/adr/0003-...
    blocked: [],
    warnings: [],
  };

  writeFileSync(runResultPath(id, home), JSON.stringify(result, null, 2));
  appendLog(logPath, `result written: ${JSON.stringify(result)}`);

  return result;
}
