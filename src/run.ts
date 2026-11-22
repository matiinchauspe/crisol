import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ProviderFailureError } from "./adapter";
import type { Adapter, AdapterContext, PreStartDeclaration } from "./adapter";
import { FakeAdapter } from "./adapters/fake";
import { allowlistByLevel, repoLevelChangeWarning } from "./allowlist";
import type { AllowlistEntry } from "./allowlist";
import { readGlobalConfig, readInstructions, readRepoGates, readRepoSecretNames } from "./config";
import type { GlobalConfig } from "./config";
import { PACKAGE_CACHE_MOUNT, PACKAGE_CACHE_VOLUME, detectPackageManager, installDependencies } from "./dependencies";
import type { PackageManager } from "./dependencies";
import {
  DEFAULT_SANDBOX_CPUS,
  DEFAULT_SANDBOX_MEMORY,
  assertDockerReachable,
  ensureImageFromDockerfile,
  removeRunSandboxes,
  startSandbox,
} from "./docker";
import type { MountSpec, Sandbox } from "./docker";
import { addTrackedSize, runDirSizeBytes } from "./gc";
import { formatGateFeedback, resolveGates, runGates } from "./gates";
import type { Gate } from "./gates";
import { createInternalNetwork, ensureProxyImage, removeNetworkByRunId, startNetworkWall } from "./network";
import type { Blocked, NetworkMode, NetworkWall, WallPolicy } from "./network";
import { readProjectDockerfile, resolveProjectLayer } from "./project-layer";
import { readRepoServices, startServices } from "./services";
import type { ServiceRuntime, ServiceSpec } from "./services";
import {
  addedLines,
  branchExists,
  branchSha,
  checkedOutWorktree,
  checkoutBranch,
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
import type { GitIdentity } from "./git";
import {
  REPO_ALLOWLIST_FILE,
  crisolHome,
  runDir,
  runGatesPath,
  runLockPath,
  runLogPath,
  runPidPath,
  runPromptPath,
  runRepoPath,
  runResultPath,
  runSessionIdPath,
  runSessionStorePath,
  runsRoot,
} from "./paths";
import { readResult, runsNamingBranch } from "./runs";
import type { BranchClaim } from "./runs";
import { KeychainSecretStore } from "./secret-store";
import type { SecretStore } from "./secret-store";
import { acquireSlot, adoptLock, tryLockRun } from "./slots";
import type { HeldLock, Slot } from "./slots";
import { readStopLine } from "./stop-line";
import type { StopReason } from "./stop-line";
import { assertPreambleNamesGates, buildPrompt, defaultPreamble, resolveSharedInputs, resolveTask } from "./task";
import type { ResolvedInputs, TaskInput } from "./task";

export type { Gate } from "./gates";
export type { Blocked, NetworkMode } from "./network";

export type RunStatus = "verified" | "unverified" | "not-converged" | StopReason;

const DEFAULT_BRANCH_PREFIX = "crisol";

const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_CEILING_MS = 60 * 60 * 1000;

const DEFAULT_MAX_PARALLEL = 3;

export function resolveMaxParallel(globalConfig: GlobalConfig): number {
  return globalConfig.maxParallel ?? DEFAULT_MAX_PARALLEL;
}

export function resolveCapacityLimits(globalConfig: GlobalConfig): { cpus: number; memory: string } {
  return {
    cpus: globalConfig.cpus ?? DEFAULT_SANDBOX_CPUS,
    memory: globalConfig.memory ?? DEFAULT_SANDBOX_MEMORY,
  };
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
  /** Which Adapter made this round. Absent for a Run that ended before resolving one, or whose Adapter has no name. */
  adapter?: string;
  iterations: number;
  gates: Gate[];
  network: NetworkMode;
  blocked: Blocked[];
  reached?: Blocked[];
  warnings: string[];
  /**
   * Whether Fetch-back brought the branch into the host repo. `false` leaves it to `crisol recover`
   * when the Run made its Clone; a Run that ended before its Slot never cut a branch.
   */
  fetchBack: boolean;
  /** Epoch ms when this result was written. `crisol gc`'s 7-day rule reads this, never a dir's own birthtime. */
  finishedAt: number;
  /**
   * The agent's last message of the Run's last iteration, verbatim as the Adapter received it.
   * Absent when no iteration finished, or the Adapter could not read one. Crisol reads nothing in
   * it but the Stop line.
   */
  finalMessage?: string;
}

/**
 * Carried on a `run()` rejection when the Run result was still computed and written. `cli.ts`
 * prints it under `--json` even though the Run failed.
 */
export interface RunFailure {
  result?: RunResult;
}

function attachResult(error: unknown, result: RunResult): unknown {
  if (error instanceof Error) (error as Error & RunFailure).result = result;
  return error;
}

/** What the Run lock file holds, for `crisol recover` to find a dead Run's branch and host repo. */
export interface RunLockRecord {
  host: string;
  branch: string;
}

export interface RunOptions extends TaskInput {
  cwd: string;
  base?: string;
  /** Pins the commit `base` names, so a fan-out cuts every Run from one commit even if the ref moves meanwhile. */
  baseSha?: string;
  name?: string;
  home?: string;
  adapter?: Adapter;
  /** Test seam: forces a run-id collision. */
  generateRunId?: () => string;
  /** Test seam: a real `docker build` cannot be made to fail on demand. */
  ensureImage?: () => Promise<string>;
  /** Test seam: a real proxy-image build cannot be made to fail on demand either. */
  ensureProxyImage?: () => Promise<string>;
  /** `--gate`; absent or empty falls through to the repo's Gates. */
  gates?: readonly string[];
  maxIterations?: number;
  ceilingMs?: number;
  network?: NetworkMode;
  /** Defaults to the login Keychain, which a test must never touch. */
  secretStore?: SecretStore;
  /** Called once if every Slot is taken and the Run starts waiting for one. */
  onSlotWait?: (maxParallel: number) => void;
  /** Called with each warning the human must act on now, such as a Sandbox left running. */
  onWarning?: (warning: string) => void;
  /** Called once a provider failure is caught, so a sibling Task still waiting for a Slot can give up rather than start into the same outage. */
  onProviderFailure?: (reason: string) => void;
  /** Called once a Continuation with no explicit `--adapter` inherits the one its Run recorded. */
  onAdapterInherited?: (adapterName: string, runId: string) => void;
  /**
   * Builds a named Adapter when a Continuation inherits one, since `run()` keeps no mapping of
   * its own — the CLI passes its own `createAdapter` table. With none supplied, inheriting
   * refuses rather than guessing which Adapter to run.
   */
  adapterByName?: (name: string) => Adapter;
  /**
   * Aborts a Run still waiting for a Slot. A Run past its Slot stops on its own signal handlers,
   * and treats a signal already aborted, with the signal's name as `reason`, as one received.
   */
  signal?: AbortSignal;
  /** Set in the process `crisol run --detach` started: the Run is already reserved, and its lock inherited. */
  detached?: DetachedHandoff;
  /** `--continue`: the branch of a finished Run to take up again, with the Task as the new request. */
  continue?: string;
}

export interface DetachedHandoff {
  run: string;
  lockFd: number;
}

function generateRunId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Names every host a user or repo level brought, since a cloned repo's level widens this Run unseen. */
function formatAllowlistLevels(entries: readonly AllowlistEntry[]): string {
  const builtIn = entries.filter((entry) => entry.level === "built-in").length;
  const named = (["user", "repo"] as const).map((level) => {
    const hosts = entries.filter((entry) => entry.level === level).map((entry) => entry.host);
    return `${level}: ${hosts.length > 0 ? hosts.join(", ") : "none"}`;
  });
  return [`${builtIn} built-in`, ...named].join("; ");
}

function formatCounts(entries: readonly Blocked[]): string {
  return entries.map((b) => `${b.host}${b.port !== undefined ? `:${b.port}` : ""}=${b.count}`).join(", ");
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
  host: string;
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
    return { id, branch, host: hostRepoPath, lock: lockRun(id, home, { host: hostRepoPath, branch }) };
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
  readonly by: string | undefined;
  readonly rejected: Promise<never>;
  throwIfInterrupted(): void;
  disarm(): void;
}

function interruptedError(by: string): Error {
  return new Error(`Run interrupted by ${by}`);
}

/**
 * Armed once the Run holds its Slot (until then the caller's `signal` stops it), and held through
 * teardown and Fetch-back. A later signal is logged and otherwise ignored: Crisol never abandons
 * a teardown half way. SIGKILL remains for that, and `crisol recover` for what it leaves behind.
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

interface PreparedRun {
  home: string;
  hostRepoPath: string;
  identity: GitIdentity;
  instructions: string | undefined;
  prompt: string;
  baseRef: string;
  baseSha: string;
  gates: readonly string[];
  maxParallel: number;
  maxIterations: number;
  ceilingMs: number;
  cpus: number;
  memory: string;
  adapter: Adapter;
  preStart: PreStartDeclaration;
  adapterSecretValues: Record<string, string>;
  secretEnvNames: string[];
  image: string;
  proxyImage: string | undefined;
  allowlist: AllowlistEntry[];
  services: ServiceSpec[];
  continued?: ContinuedRun;
}

interface ContinuedRun {
  id: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  sessionId: string;
  /** Absent for a Run that predates `gates.json`. */
  gates?: readonly string[];
  adapterName?: string;
}

function readKeptGates(id: string, home: string): readonly string[] | undefined {
  const file = runGatesPath(id, home);
  if (!existsSync(file)) return undefined;
  const gates: unknown = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(gates) && gates.every((gate) => typeof gate === "string") ? gates : undefined;
}

function readKeptSessionId(id: string, home: string): string | undefined {
  try {
    const sessionId = readFileSync(runSessionIdPath(id, home), "utf8").trim();
    return sessionId === "" ? undefined : sessionId;
  } catch {
    return undefined;
  }
}

/**
 * Both failures below leave the Clone's branch diverged from the host for good once a round has
 * run on top of it, so a Continuation checks for them before any Sandbox starts rather than only
 * at Fetch-back.
 */
function assertBranchContinuable(hostRepoPath: string, clonePath: string, branch: string): void {
  const worktree = checkedOutWorktree(hostRepoPath, branch);
  if (worktree !== undefined) {
    throw new Error(
      `Branch "${branch}" is checked out at ${worktree}; Fetch-back cannot update a branch git has ` +
        `checked out. Check out something else there, then continue "${branch}" again.`,
    );
  }
  const hostSha = branchSha(hostRepoPath, branch);
  const cloneSha = branchSha(clonePath, branch);
  if (hostSha !== cloneSha) {
    throw new Error(
      `Branch "${branch}" is at ${hostSha ?? "no such branch"} in ${hostRepoPath}, but at ` +
        `${cloneSha ?? "no such branch"} in its Run's Clone. A Continuation needs the two to match, so none ` +
        `started; which side to bring forward is yours to decide.`,
    );
  }
}

/**
 * `crisol gc` only ever collects a Run whose Fetch-back already completed (`planGc`'s own first
 * check), so a claimant with no Clone and `fetchBack: true` can only have lost it to `gc`; one with
 * `fetchBack: false` never made a Clone to begin with, since nothing else ever removes `repo/`.
 */
function describeCloneless(claim: BranchClaim, branch: string): string {
  const cause = claim.fetchBack ? "`crisol gc` collected it" : "it ended before it ever held a Slot and never made one";
  return `Run ${claim.run} names branch "${branch}" in its Run result but has no Clone to resume from (${cause})`;
}

function findContinuedRun(hostRepoPath: string, home: string, branch: string): ContinuedRun {
  const claims = runsNamingBranch(home, hostRepoPath, branch);
  const owners = claims.filter((claim) => claim.hasClone).map((claim) => claim.run);
  if (owners.length === 0) {
    if (claims.length === 0) {
      throw new Error(
        `No finished Run of ${hostRepoPath} names branch "${branch}" in its Run result, so there is nothing to ` +
          "continue. `crisol status` lists every Run and its branch.",
      );
    }
    throw new Error(`${claims.map((claim) => describeCloneless(claim, branch)).join("; ")}, so it cannot be continued.`);
  }
  if (owners.length > 1) {
    throw new Error(
      `Branch "${branch}" is claimed by ${owners.length} Runs (${owners.join(", ")}); a Continuation takes up ` +
        "exactly one, so none was started.",
    );
  }
  const id = owners[0]!;
  const clonePath = runRepoPath(id, home);
  if (!existsSync(clonePath)) {
    throw new Error(`Run ${id}'s Clone is gone (\`crisol gc\` collected it), so branch "${branch}" cannot be continued.`);
  }
  assertBranchContinuable(hostRepoPath, clonePath, branch);
  const sessionId = readKeptSessionId(id, home);
  if (sessionId === undefined) {
    throw new Error(`Run ${id} kept no agent session, so branch "${branch}" cannot be continued.`);
  }
  const ownerResult = readResult(id, home)!;
  const base = ownerResult.base;
  const at = base.lastIndexOf("@");
  return {
    id,
    branch,
    baseRef: base.slice(0, at),
    baseSha: base.slice(at + 1),
    sessionId,
    gates: readKeptGates(id, home),
    adapterName: ownerResult.adapter,
  };
}

function assertContinuableAdapterNamed(adapter: Adapter): Adapter {
  if (adapter.continueSession !== undefined && adapter.name === undefined) {
    throw new Error(
      "This Adapter implements continueSession but has no name, so a Run it makes would record no Adapter " +
        "for a Continuation to inherit or match; give it a name.",
    );
  }
  return adapter;
}

function assertAdapterContinues(adapter: Adapter, continued: ContinuedRun): void {
  if (adapter.continueSession === undefined) {
    throw new Error(`This Adapter cannot continue a session, so branch "${continued.branch}" cannot be continued.`);
  }
  assertContinuableAdapterNamed(adapter);
}

/** Called before any Sandbox starts, so every Adapter refusal here costs no Docker work. */
function resolveAdapter(
  requested: Adapter | undefined,
  continued: ContinuedRun | undefined,
  byName: ((name: string) => Adapter) | undefined,
  onInherited: ((adapterName: string, runId: string) => void) | undefined,
): Adapter {
  if (continued === undefined) return assertContinuableAdapterNamed(requested ?? new FakeAdapter());
  if (requested !== undefined) {
    assertAdapterContinues(requested, continued);
    if (continued.adapterName !== undefined && requested.name !== continued.adapterName) {
      throw new Error(
        `Branch "${continued.branch}" was made with Adapter "${continued.adapterName}", not ` +
          `"${requested.name}"; pass --adapter ${continued.adapterName} to continue it, or start a fresh Run.`,
      );
    }
    return requested;
  }
  if (continued.adapterName === undefined) {
    throw new Error(
      `Run ${continued.id} kept no record of which Adapter made it; pass --adapter to continue branch "${continued.branch}".`,
    );
  }
  if (byName === undefined) {
    throw new Error(
      `Branch "${continued.branch}" inherits Adapter "${continued.adapterName}", but no adapterByName was ` +
        "given to build one; pass --adapter explicitly, or supply adapterByName.",
    );
  }
  const inherited = byName(continued.adapterName);
  assertAdapterContinues(inherited, continued);
  onInherited?.(continued.adapterName, continued.id);
  return inherited;
}

/**
 * `savedPrompt` is the prompt the detaching process resolved, so a detached Run never re-reads a
 * user's path. `sharedInputs` is a fan-out's Template and `--context` files, read once by its
 * caller for the same reason.
 */
async function prepareRun(options: RunOptions, savedPrompt?: string, sharedInputs?: ResolvedInputs): Promise<PreparedRun> {
  const home = options.home ?? crisolHome();
  const hostRepoPath = discoverGitRoot(options.cwd);
  if (!hostRepoPath) {
    throw new Error(`Not inside a git repo: ${options.cwd}`);
  }

  // Every validation below runs BEFORE any side effect — no mkdir, no clone, no docker run.
  const identity = readIdentity(hostRepoPath);
  const instructions = readInstructions(home);
  const resolved =
    savedPrompt === undefined ? resolveTask(options, options.cwd, home, hostRepoPath, sharedInputs) : undefined;

  const continued = options.continue !== undefined ? findContinuedRun(hostRepoPath, home, options.continue) : undefined;
  let baseRef: string;
  let baseSha: string;
  if (continued !== undefined) {
    ({ baseRef, baseSha } = continued);
  } else {
    baseRef = options.base ?? currentRefName(hostRepoPath);
    baseSha = options.baseSha ?? resolveBaseSha(hostRepoPath, baseRef);
    assertBaseReachable(hostRepoPath, baseRef, baseSha);
    if (options.name !== undefined) {
      assertBranchAvailable(hostRepoPath, options.name);
    } else {
      assertDefaultPrefixAvailable(hostRepoPath);
    }
  }

  const gates = resolveGates(options.gates, continued?.gates ?? readRepoGates(hostRepoPath));
  const globalConfig = readGlobalConfig(home);
  const maxParallel = resolveMaxParallel(globalConfig);
  const { maxIterations, ceilingMs } = resolveCeiling(
    { maxIterations: options.maxIterations, ceilingMs: options.ceilingMs },
    globalConfig,
    { maxIterations: DEFAULT_MAX_ITERATIONS, ceilingMs: DEFAULT_CEILING_MS },
  );
  const { cpus, memory } = resolveCapacityLimits(globalConfig);

  const repoSecretNames = readRepoSecretNames(hostRepoPath);
  assertDeclaredSecretsPresent(repoSecretNames);

  // Only a wall enforces the levels, so only an allowlist Run reads them: a bad line in one fails
  // that Run now, and never breaks the learn or open escape hatches.
  const allowlist = (options.network ?? "allowlist") === "allowlist" ? allowlistByLevel(home, hostRepoPath) : [];

  // Validated before any side effect, like every other `.crisol/` declaration: a bad compose key
  // fails the Run here, before a Clone or a branch exists.
  const services = readRepoServices(hostRepoPath);

  const projectLayer = resolveProjectLayer(readProjectDockerfile(hostRepoPath));

  assertDockerReachable();

  const adapter = resolveAdapter(options.adapter, continued, options.adapterByName, options.onAdapterInherited);
  let prompt = savedPrompt ?? "";
  if (resolved !== undefined) {
    const preamble = adapter.preamble?.(gates) ?? defaultPreamble(gates);
    assertPreambleNamesGates(preamble, gates);
    prompt = buildPrompt(preamble, resolved);
  }
  const preStart = adapter.declarePreStart(projectLayer.tag);
  const secretStore = options.secretStore ?? new KeychainSecretStore();
  const adapterSecretValues = resolveAdapterSecretValues(secretStore, preStart.envNames);
  const secretEnvNames = Array.from(new Set([...preStart.envNames, ...repoSecretNames]));

  // `options.ensureImage` is a test seam that bypasses both layers.
  const ensureImage = async (): Promise<string> => {
    if (options.ensureImage !== undefined) return options.ensureImage();
    await ensureImageFromDockerfile(projectLayer.tag, projectLayer.dockerfile);
    return preStart.ensureImage !== undefined ? preStart.ensureImage() : projectLayer.tag;
  };
  const ensureProxyImageFn = options.ensureProxyImage ?? ensureProxyImage;
  // An offline first Run must fail here, never after leaving a Clone and a branch behind —
  // the Allowlist proxy's image is resolved pre-flight for the same reason the Sandbox's is.
  const [image, proxyImage] = await Promise.all([
    ensureImage(),
    options.network === "open" ? undefined : ensureProxyImageFn(),
  ]);

  return {
    home,
    hostRepoPath,
    identity,
    instructions,
    prompt,
    baseRef,
    baseSha,
    gates,
    maxParallel,
    maxIterations,
    ceilingMs,
    cpus,
    memory,
    adapter,
    preStart,
    adapterSecretValues,
    secretEnvNames,
    image,
    proxyImage,
    allowlist,
    services,
    continued,
  };
}

function reserveFresh(prepared: PreparedRun, options: RunOptions): Reservation {
  const { home, hostRepoPath } = prepared;
  let reservation: Reservation | undefined;
  try {
    reservation = reserveRun(hostRepoPath, home, options.name, options.generateRunId ?? generateRunId);
    writeFileSync(runLogPath(reservation.id, home), "");
    writeFileSync(runPromptPath(reservation.id, home), prepared.prompt);
    writeFileSync(runGatesPath(reservation.id, home), JSON.stringify(prepared.gates));
  } catch (error) {
    reservation?.lock.release();
    throw error;
  }
  appendLog(
    runLogPath(reservation.id, home),
    `run ${reservation.id} reserved: prompt in ${runPromptPath(reservation.id, home)} ` +
      `base=${prepared.baseRef}@${prepared.baseSha} branch=${reservation.branch}`,
  );
  return reservation;
}

/**
 * Re-takes the finished Run's own lock, so a second Continuation of it, or `crisol recover`, waits
 * out this one. The log is appended to, never reset: it is the only record of earlier rounds.
 */
function reserveContinuation(prepared: PreparedRun, continued: ContinuedRun): Reservation {
  const { home, hostRepoPath } = prepared;
  const lock = lockRun(continued.id, home, { host: hostRepoPath, branch: continued.branch });
  appendLog(
    runLogPath(continued.id, home),
    `continuation of ${continued.branch} reserved, resuming session ${continued.sessionId}: ` +
      `prompt ${JSON.stringify(prepared.prompt)}`,
  );
  return { id: continued.id, branch: continued.branch, host: hostRepoPath, lock };
}

/**
 * A Continuation that ends before its Slot leaves the Run result as the last round wrote it: that
 * round's branch and status still stand, and this one changed nothing.
 */
function endUnstartedContinuation(reservation: Reservation, home: string, signal: AbortSignal | undefined, error: unknown): void {
  const reason = signal?.aborted ? `interrupted: ${typeof signal.reason === "string" ? signal.reason : "abort"}` : `error: ${errorMessage(error)}`;
  try {
    appendLog(runLogPath(reservation.id, home), `continuation ended before it held a Slot (${reason}); the Run result is unchanged`);
  } catch {}
  reservation.lock.release();
}

/** Before pre-flight, so the process that owns a detached Run holds it from its first step. */
function adoptReservation(detached: DetachedHandoff, home: string): Reservation {
  const lockPath = runLockPath(detached.run, home);
  const lock = adoptLock(detached.lockFd, lockPath);
  // The detaching process chose the branch and the host repo; the record is where it left them.
  const record = JSON.parse(readFileSync(lockPath, "utf8")) as RunLockRecord;
  return { id: detached.run, branch: record.branch, host: record.host, lock };
}

/** Only for a reservation whose id was never handed to anyone. */
function discardReservation(reservation: Reservation, home: string): void {
  rmSync(runDir(reservation.id, home), { recursive: true, force: true });
  reservation.lock.release();
}

/**
 * A Run that ends before it holds a Slot keeps its dir, log and a Run result, like any other Run:
 * its id may already have been handed out, and only `crisol gc` deletes Run state. It never cut a
 * branch, so there is nothing to fetch back. Never throws, so the error that ended the Run is the
 * one its caller sees; returns the result it computed so the caller can attach it to that error.
 * `adapterName` is set only when pre-flight had already resolved one before this Run ended.
 */
function endUnstartedRun(
  reservation: Reservation,
  home: string,
  base: string,
  network: NetworkMode,
  signal: AbortSignal | undefined,
  error: unknown,
  adapterName?: string,
): RunResult {
  const reason = signal?.aborted
    ? `interrupted: ${typeof signal.reason === "string" ? signal.reason : "abort"}`
    : `error: ${errorMessage(error)}`;
  const result: RunResult = {
    run: reservation.id,
    branch: reservation.branch,
    base,
    status: "not-converged",
    reason,
    ...(adapterName !== undefined ? { adapter: adapterName } : {}),
    iterations: 0,
    gates: [],
    network,
    blocked: [],
    warnings: [],
    fetchBack: false,
    finishedAt: Date.now(),
  };
  const logPath = runLogPath(reservation.id, home);
  try {
    appendLog(logPath, `ended before it held a Slot (${reason}); no Clone, no branch`);
    writeFileSync(runResultPath(reservation.id, home), JSON.stringify(result, null, 2));
    appendLog(logPath, `result written: ${JSON.stringify(result)}`);
  } catch (writeError) {
    try {
      appendLog(logPath, `result.json could not be written: ${errorMessage(writeError)}`);
    } catch {}
  } finally {
    reservation.lock.release();
  }
  return result;
}

export interface DetachedRun {
  id: string;
  baseRef: string;
  baseSha: string;
  logPath: string;
  pidPath: string;
  lock: HeldLock;
  discard(): void;
  end(error: unknown): void;
}

/** Pre-flight and reservation only, so the terminal still sees a bad base, name or Gate. */
export async function reserveDetachedRun(options: RunOptions): Promise<DetachedRun> {
  if (options.continue !== undefined) throw new Error("A Continuation cannot be detached.");
  const prepared = await prepareRun(options);
  if (options.signal?.aborted) throw interruptedBeforeReserving();
  const reservation = reserveFresh(prepared, options);
  const base = `${prepared.baseRef}@${prepared.baseSha}`;
  return {
    id: reservation.id,
    baseRef: prepared.baseRef,
    baseSha: prepared.baseSha,
    logPath: runLogPath(reservation.id, prepared.home),
    pidPath: runPidPath(reservation.id, prepared.home),
    lock: reservation.lock,
    discard: () => discardReservation(reservation, prepared.home),
    end: (error) =>
      endUnstartedRun(reservation, prepared.home, base, options.network ?? "allowlist", undefined, error, prepared.adapter.name),
  };
}

function interruptedBeforeReserving(): Error {
  return new Error("Interrupted before the Run was reserved; nothing was left behind.");
}

/**
 * Crisol, never the agent, decides done: every declared Gate runs, a red one resumes the same
 * session with its failure, until all are green or the ceiling hits. With no Gate anywhere, the
 * agent's completion report stands in. The agent decides only whether to stop on purpose: a Stop
 * line ends the Run before the Gates. Once the Run holds a Slot, Fetch-back runs on every exit,
 * whatever `status` is.
 */
export async function run(options: RunOptions, sharedInputs?: ResolvedInputs): Promise<RunResult> {
  const home = options.home ?? crisolHome();
  const networkMode = options.network ?? "allowlist";
  let reservation: Reservation;
  let prepared: PreparedRun;
  let base: string;
  // Separate from `prepared`: reading `prepared` before assignment in the catches below would trip
  // TS's "used before assigned" check; `string | undefined` is exempt.
  let adapterName: string | undefined;
  if (options.detached) {
    reservation = adoptReservation(options.detached, home);
    base = `${options.base}@${options.baseSha}`;
    try {
      writeFileSync(runPidPath(reservation.id, home), String(process.pid));
      prepared = await prepareRun(options, readFileSync(runPromptPath(reservation.id, home), "utf8"));
      adapterName = prepared.adapter.name;
      if (prepared.hostRepoPath !== reservation.host) {
        throw new Error(`Run ${reservation.id} was reserved for ${reservation.host}, not ${prepared.hostRepoPath}.`);
      }
    } catch (error) {
      const result = endUnstartedRun(reservation, home, base, networkMode, options.signal, error, adapterName);
      throw attachResult(error, result);
    }
  } else {
    prepared = await prepareRun(options, undefined, sharedInputs);
    adapterName = prepared.adapter.name;
    await letSignalsLand();
    // The user never saw an id yet, so a signal in pre-flight leaves nothing, as a failed check does.
    if (options.signal?.aborted) throw interruptedBeforeReserving();
    // Reserved before the Slot wait, so `crisol status` can show the Run as queued.
    reservation =
      prepared.continued !== undefined ? reserveContinuation(prepared, prepared.continued) : reserveFresh(prepared, options);
    base = `${prepared.baseRef}@${prepared.baseSha}`;
    try {
      writeFileSync(runPidPath(reservation.id, home), String(process.pid));
    } catch (error) {
      if (prepared.continued !== undefined) {
        endUnstartedContinuation(reservation, home, options.signal, error);
        throw error;
      }
      const result = endUnstartedRun(reservation, home, base, networkMode, options.signal, error, adapterName);
      throw attachResult(error, result);
    }
  }
  const {
    hostRepoPath,
    identity,
    instructions,
    prompt,
    baseSha,
    gates,
    maxParallel,
    maxIterations,
    ceilingMs,
    cpus,
    memory,
    adapter,
    preStart,
    adapterSecretValues,
    secretEnvNames,
    image,
    proxyImage,
    allowlist,
    services,
    continued,
  } = prepared;

  let slot: Slot;
  try {
    slot = await acquireSlot({
      home,
      maxParallel,
      onWait: () => options.onSlotWait?.(maxParallel),
      signal: options.signal,
    });
  } catch (error) {
    if (continued !== undefined) {
      endUnstartedContinuation(reservation, home, options.signal, error);
      throw error;
    }
    const result = endUnstartedRun(reservation, home, base, networkMode, options.signal, error);
    throw attachResult(error, result);
  }

  const { id, branch, lock } = reservation;
  const logPath = runLogPath(id, home);
  const clonePath = runRepoPath(id, home);
  const interruption = armInterruption(logPath, options.signal);
  // Already in the tally from the round that wrote it; counting it again would inflate gc's warning.
  let talliedBytes = 0;
  if (continued !== undefined) {
    try {
      talliedBytes = runDirSizeBytes(id, home);
    } catch {}
  }

  appendLog(
    logPath,
    `run ${id} ${continued !== undefined ? "continuing" : "starting"}: base=${base} branch=${branch} ` +
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
  let wall: NetworkWall | undefined;
  let serviceRuntime: ServiceRuntime | undefined;
  /** Set only when Services created their own network because no wall did (open mode); teardown removes it only then. */
  let bareServicesNetwork: string | undefined;
  let blocked: Blocked[] = [];
  let reached: Blocked[] = [];
  let finalMessage: string | undefined;
  /** Where this round's commits start: a Continuation's earlier rounds were scanned when they ran. */
  let scanFrom = baseSha;
  const keepTurn = (message: string | void): void => {
    finalMessage = typeof message === "string" ? message : undefined;
    const session = adapter.sessionId?.();
    if (session === undefined) return;
    // Best-effort: losing it costs only a later Continuation, never this Run.
    try {
      writeFileSync(runSessionIdPath(id, home), session);
    } catch (error) {
      appendLog(logPath, `session id could not be kept: ${errorMessage(error)}`);
    }
  };

  // Cleared before the await: a throw here leaves no message, not the prior turn's.
  const runTurn = async (turn: Promise<string | void>): Promise<void> => {
    finalMessage = undefined;
    keepTurn(await turn);
  };

  const converge = async (ctx: AdapterContext): Promise<void> => {
    await runTurn(continued !== undefined ? adapter.continueSession!(ctx, continued.sessionId, prompt) : adapter.launch(ctx));
    iterations = 1;
    const startedAt = Date.now();

    while (true) {
      // The race below has already moved on; this keeps an interrupted loop from resuming the agent.
      interruption.throwIfInterrupted();
      const completed = await adapter.reportCompletion(ctx);
      appendLog(logPath, `adapter reported completion=${completed} after ${iterations} iteration(s)`);

      // Before any Gate: an agent that stopped on purpose is not pushed back to work.
      const stop = finalMessage !== undefined ? readStopLine(finalMessage) : undefined;
      if (stop !== undefined) {
        status = stop;
        appendLog(logPath, `Stop line (${stop}) after ${iterations} iteration(s): no Gate runs, no resume`);
        return;
      }

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
      await runTurn(adapter.resumeWithFeedback(ctx, formatGateFeedback(firstFailure)));
      iterations += 1;
    }
  };

  try {
    try {
      if (continued !== undefined) {
        checkoutBranch(clonePath, branch);
        scanFrom = branchSha(clonePath, branch) ?? baseSha;
        appendLog(logPath, `continuing in the Clone at ${clonePath}, branch ${branch} at ${scanFrom}`);
      } else {
        // Made even when a signal already landed: an interrupted Run still leaves its branch.
        cloneLocal(hostRepoPath, clonePath);
        checkoutNewBranch(clonePath, branch, baseSha);
        appendLog(logPath, `clone ready at ${clonePath}, branch ${branch} cut from ${baseSha}`);
      }
      await letSignalsLand();
      interruption.throwIfInterrupted();

      // Detected from the Clone, never the host's own working tree, which may sit on a different
      // commit entirely.
      const packageManager: PackageManager | undefined = detectPackageManager(clonePath);
      if (packageManager !== undefined) {
        appendLog(logPath, `package manager detected: ${packageManager}`);
      }

      // Any wall goes up BEFORE the Sandbox exists: the network a container joins is fixed at
      // `docker run` time, like every other pre-start declaration.
      if (proxyImage !== undefined && networkMode !== "open") {
        const policy: WallPolicy =
          networkMode === "learn"
            ? { mode: "learn" }
            : { mode: "allowlist", hosts: allowlist.map((entry) => entry.host) };
        wall = await startNetworkWall(id, home, proxyImage, policy);
        appendLog(logPath, `network wall up (${networkMode}): ${wall.networkName}`);
        if (networkMode === "allowlist") appendLog(logPath, `allowlist: ${formatAllowlistLevels(allowlist)}`);
      } else {
        appendLog(logPath, "network open: no wall, the Sandbox is on Docker's default network");
      }
      await letSignalsLand();
      interruption.throwIfInterrupted();

      // Services, like the wall, go up before the Sandbox exists: the agent starts only once every
      // healthcheck passes, so a never-healthy service fails the Run before any iteration is spent.
      let servicesNetwork: string | undefined;
      if (services.length > 0) {
        servicesNetwork = wall?.networkName;
        if (servicesNetwork === undefined) {
          // Open mode stood up no wall, so Services get a bare internal network of their own.
          servicesNetwork = await createInternalNetwork(id);
          bareServicesNetwork = servicesNetwork;
        }
        serviceRuntime = await startServices(id, servicesNetwork, services);
        appendLog(logPath, `services up on ${servicesNetwork}: ${services.map((service) => service.name).join(", ")}`);
        await letSignalsLand();
        interruption.throwIfInterrupted();
        await serviceRuntime.waitHealthy();
        appendLog(logPath, "services healthy");
      }
      await letSignalsLand();
      interruption.throwIfInterrupted();

      const sessionMounts: MountSpec[] = [];
      if (adapter.sessionStore !== undefined) {
        mkdirSync(runSessionStorePath(id, home), { recursive: true });
        sessionMounts.push({ hostPath: runSessionStorePath(id, home), containerPath: adapter.sessionStore, mode: "rw" });
      }

      sandbox = await startSandbox({
        image,
        mountPath: clonePath,
        env: {
          GIT_AUTHOR_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_COMMITTER_NAME: identity.name,
          GIT_COMMITTER_EMAIL: identity.email,
          ...wall?.proxyEnv,
        },
        secretEnvNames,
        secretEnv: adapterSecretValues,
        mounts: [...preStart.mounts, ...sessionMounts],
        volumeMounts:
          packageManager !== undefined
            ? [{ volume: PACKAGE_CACHE_VOLUME, containerPath: PACKAGE_CACHE_MOUNT }]
            : [],
        network: wall?.networkName,
        servicesNetwork,
        id,
        cpus,
        memory,
      });
      appendLog(
        logPath,
        `sandbox ${sandbox.containerId} started from ${image}, mounts=${sandbox.mounts.join(",")}`,
      );
      appendLog(logPath, `sandbox capacity: cpus=${cpus}, memory=${memory}`);

      // Before the agent launches, so a broken install fails the Run with `iterations: 0`.
      if (packageManager !== undefined) {
        await installDependencies(sandbox, packageManager);
        appendLog(logPath, `dependencies installed with ${packageManager}`);
      }
      await letSignalsLand();
      interruption.throwIfInterrupted();

      await Promise.race([
        converge({ sandbox, repoPath: clonePath, prompt, instructions }),
        interruption.rejected,
      ]);

      // Best-effort: a failed scan must not turn a converged Run into a failed one.
      try {
        warnings.push(...scanCommitsForWarnings(clonePath, `${scanFrom}..${branch}`, identity));
        const repoLevelChange = addedLines(clonePath, `${scanFrom}..${branch}`, REPO_ALLOWLIST_FILE);
        if (repoLevelChange !== undefined) warnings.push(repoLevelChangeWarning(repoLevelChange));
      } catch (error) {
        appendLog(logPath, `commit scan failed: ${errorMessage(error)}`);
      }
    } catch (error) {
      primaryError = error;
      appendLog(logPath, `primary error: ${errorMessage(error)}`);
      if (error instanceof ProviderFailureError) options.onProviderFailure?.(`provider: ${error.category}`);
    }

    // Read before the proxy container is removed — there is no log left to read after.
    if (wall) {
      try {
        ({ blocked, reached } = await wall.readTraffic());
        if (blocked.length > 0) appendLog(logPath, `blocked: ${formatCounts(blocked)}`);
        if (networkMode === "learn" && reached.length > 0) appendLog(logPath, `reached: ${formatCounts(reached)}`);
      } catch (error) {
        appendLog(logPath, `reading the proxy's log failed: ${errorMessage(error)}`);
      }
    }

    const teardownWarning = await tearDown(sandbox, id, logPath);
    if (teardownWarning !== undefined) {
      warnings.push(teardownWarning);
      options.onWarning?.(teardownWarning);
    }

    // Before the wall's own network removal below: `docker network rm` refuses a network that
    // still has an attached container, and a service container is exactly that.
    if (serviceRuntime) {
      const servicesTeardown = await serviceRuntime.teardown();
      if (servicesTeardown.ok) {
        appendLog(logPath, "services torn down");
      } else {
        const servicesWarning =
          `Service container(s) for Run ${id} could not be fully removed ` +
          `(${servicesTeardown.stderr || "docker failed"}); remove them with \`docker rm -f\` by name ` +
          `(crisol-svc-${id}-<service>).`;
        appendLog(logPath, `services teardown FAILED: ${servicesTeardown.stderr}`);
        warnings.push(servicesWarning);
        options.onWarning?.(servicesWarning);
      }
    }
    if (bareServicesNetwork !== undefined) {
      const servicesNetworkRemoved = await removeNetworkByRunId(id);
      if (!servicesNetworkRemoved.ok) {
        const networkWarning =
          `Services network ${bareServicesNetwork} for Run ${id} could not be removed ` +
          `(${servicesNetworkRemoved.stderr || "docker failed"}); remove it with ` +
          `\`docker network rm ${bareServicesNetwork}\`.`;
        appendLog(logPath, `services network teardown FAILED: ${servicesNetworkRemoved.stderr}`);
        warnings.push(networkWarning);
        options.onWarning?.(networkWarning);
      }
    }

    if (wall) {
      const wallTeardown = await wall.teardown();
      if (wallTeardown.ok) {
        appendLog(logPath, `network wall ${wall.networkName} torn down`);
      } else {
        const wallWarning = `Allowlist proxy/network for Run ${id} could not be fully removed ` +
          `(${wallTeardown.stderr || "docker failed"}); remove \`crisol-proxy-${id}\` and ` +
          `\`${wall.networkName}\` by hand.`;
        appendLog(logPath, `network wall teardown FAILED: ${wallTeardown.stderr}`);
        warnings.push(wallWarning);
        options.onWarning?.(wallWarning);
      }
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
      if (interruption.by !== undefined) {
        reason = `interrupted: ${interruption.by}`;
      } else if (primaryError instanceof ProviderFailureError) {
        reason = `provider: ${primaryError.category}`;
      } else {
        reason = `error: ${errorMessage(primaryError)}`;
      }
    }
    const result: RunResult = {
      run: id,
      branch,
      base,
      status,
      ...(reason !== undefined ? { reason } : {}),
      ...(adapter.name !== undefined ? { adapter: adapter.name } : {}),
      iterations,
      gates: gateResults,
      network: networkMode,
      blocked,
      ...(networkMode === "learn" ? { reached } : {}),
      warnings,
      fetchBack: fetchedBack,
      finishedAt: Date.now(),
      ...(finalMessage !== undefined ? { finalMessage } : {}),
    };

    // Written on every exit, before the Run lock frees: recover and gc read it as the Run's last word.
    try {
      writeFileSync(runResultPath(id, home), JSON.stringify(result, null, 2));
      appendLog(logPath, `result written: ${JSON.stringify(result)}`);
    } catch (error) {
      resultError = error;
      appendLog(logPath, `result.json could not be written: ${errorMessage(error)}`);
    }
    // Best-effort: a disk-usage tally must never fail a Run that otherwise finished.
    try {
      addTrackedSize(home, runDirSizeBytes(id, home) - talliedBytes);
    } catch {}

    // A provider failure resolves rather than rejects, as long as nothing else also went wrong.
    if (primaryError instanceof ProviderFailureError && fetchBackError === undefined && resultError === undefined) {
      return result;
    }

    const errors = [primaryError, fetchBackError].filter((error) => error !== undefined);
    if (errors.length === 2) {
      throw attachResult(new AggregateError(errors, "Run failed and Fetch-back also failed"), result);
    }
    if (errors.length === 1) throw attachResult(errors[0], result);
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
 * hides the others' branches. `file` is excluded: a fan-out's Tasks are phrases, never one file
 * replayed under each of them (`resolveTask` also refuses the combination, for a caller that
 * bypasses this type).
 */
export async function runFanOut(
  tasks: readonly string[],
  options: Omit<RunOptions, "task" | "name" | "baseSha" | "file">,
): Promise<PromiseSettledResult<RunResult>[]> {
  const hostRepoPath = discoverGitRoot(options.cwd);
  if (!hostRepoPath) {
    throw new Error(`Not inside a git repo: ${options.cwd}`);
  }
  const home = options.home ?? crisolHome();
  const base = options.base ?? currentRefName(hostRepoPath);
  const baseSha = resolveBaseSha(hostRepoPath, base);
  const sharedInputs = resolveSharedInputs(options, options.cwd, home, hostRepoPath);
  return Promise.allSettled(tasks.map((task) => run({ ...options, task, base, baseSha }, sharedInputs)));
}
