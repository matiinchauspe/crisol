#!/usr/bin/env bun
import packageJson from "../package.json";
import type { Adapter } from "./adapter";
import { ClaudeCodeAdapter } from "./adapters/claude-code";
import { DEFAULT_SCRIPT, FakeAdapter } from "./adapters/fake";
import { addToRepoAllowlist, addToUserAllowlist, hostsToLearn, learnBaseline, mergedAllowlist } from "./allowlist";
import type { AllowOutcome } from "./allowlist";
import { runAuth } from "./auth";
import { parsePositiveInteger, readGlobalConfig } from "./config";
import { discoverGitRoot } from "./git";
import { collectRun, formatGb, formatSizeWarning, planGc, reconcileTrackedSize, resolveGcWarnBytes, trackedRunsSizeBytes } from "./gc";
import type { GcSkip } from "./gc";
import { initRepo, LEARN_TASK, REPO_CONFIG_FILE, SANDBOX_HEADING, writeLearnedHosts } from "./init";
import type { InitReport } from "./init";
import { crisolHome, REPO_ALLOWLIST_FILE, repoAllowlistPath, userAllowlistPath } from "./paths";
import { assertSupportedPlatform } from "./platform";
import { detachRun, takeDetachedHandoff } from "./detach";
import { recover } from "./recover";
import type { RecoverOutcome } from "./recover";
import { run, runFanOut } from "./run";
import { listRuns, readRunLog } from "./runs";
import type { RunEntry } from "./runs";
import { BUILT_IN_ALLOWLIST, isInternalHostname, isPlainHostname } from "./network";
import type { Blocked, NetworkMode, RunFailure, RunOptions, RunResult } from "./run";
import { CLAUDE_TOKEN_SECRET_NAME } from "./secret-store";

const USAGE =
  'Usage: crisol run ("<task>"... | --file <md>) [--context <md>]... [--prompt <name>] [--json | --detach] [--base <ref>] [--name <branch> | --continue <branch>] [--gate <cmd>]... ' +
  "[--max-iterations <n>] [--timeout <minutes>] [--network <allowlist|learn|open>] [--adapter <fake|claude-code>]";

const ALLOW_USAGE = "Usage: crisol allow <host> [--repo]";

const AUTH_USAGE = "Usage: crisol auth";

const RECOVER_USAGE = "Usage: crisol recover";

const STATUS_USAGE = "Usage: crisol status";

const LOGS_USAGE = "Usage: crisol logs <run>";

const GC_USAGE = "Usage: crisol gc [--include-failed]";

const INIT_USAGE = "Usage: crisol init [--adapter <fake|claude-code>]";

const VERSION_USAGE = "Usage: crisol --version";

const NETWORK_MODES: readonly NetworkMode[] = ["allowlist", "learn", "open"];

const ADAPTER_NAMES = ["fake", "claude-code"] as const;
type AdapterName = (typeof ADAPTER_NAMES)[number];

/** A real agent always ends its turn with a message; a silent stand-in would return a Run result no real caller sees. */
const STAND_IN_MESSAGE = "The scripted stand-in Adapter ran; no agent worked on this Task.";

/**
 * The one table Crisol builds Adapters by name from. `run()` also calls this, as `adapterByName`,
 * with whatever name a Continuation's Run recorded — never a validated `AdapterName` — hence the
 * runtime check rather than trusting the type.
 */
function createAdapter(name: string): Adapter {
  if (name === "claude-code") return new ClaudeCodeAdapter();
  if (name === "fake") return new FakeAdapter(DEFAULT_SCRIPT, undefined, undefined, { launch: STAND_IN_MESSAGE, continue: STAND_IN_MESSAGE });
  throw new Error(`Run recorded an unknown Adapter "${name}"; pass --adapter explicitly to continue it.`);
}

interface ParsedRunArgs {
  tasks: string[];
  file?: string;
  context: string[];
  template?: string;
  json: boolean;
  detach: boolean;
  base?: string;
  name?: string;
  continue?: string;
  gates: string[];
  maxIterations?: number;
  timeoutMinutes?: number;
  network: NetworkMode;
  adapterName?: AdapterName;
}

/** A value that looks like another flag is a usage error, or `--base --json` would quietly run with no base. */
function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.\n${USAGE}`);
  }
  return value;
}

function readIntFlagValue(argv: string[], index: number, flag: string): number {
  const raw = readFlagValue(argv, index, flag);
  const value = parsePositiveInteger(raw);
  if (value === undefined) {
    throw new Error(`${flag} must be a positive integer, got "${raw}".\n${USAGE}`);
  }
  return value;
}

function readAdapterFlagValue(argv: string[], index: number): AdapterName {
  const raw = readFlagValue(argv, index, "--adapter");
  if (!(ADAPTER_NAMES as readonly string[]).includes(raw)) {
    throw new Error(`--adapter must be one of ${ADAPTER_NAMES.join(", ")}, got "${raw}".\n${USAGE}`);
  }
  return raw as AdapterName;
}

function readNetworkFlagValue(argv: string[], index: number): NetworkMode {
  const raw = readFlagValue(argv, index, "--network");
  const mode = NETWORK_MODES.find((candidate) => candidate === raw);
  if (mode === undefined) {
    throw new Error(`--network must be one of ${NETWORK_MODES.join(", ")}, got "${raw}".\n${USAGE}`);
  }
  return mode;
}

function parseRunArgs(argv: string[]): ParsedRunArgs {
  const tasks: string[] = [];
  let file: string | undefined;
  const context: string[] = [];
  let template: string | undefined;
  let json = false;
  let detach = false;
  let base: string | undefined;
  let name: string | undefined;
  let continued: string | undefined;
  const gates: string[] = [];
  let maxIterations: number | undefined;
  let timeoutMinutes: number | undefined;
  let network: NetworkMode = "allowlist";
  let adapterName: AdapterName | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--detach") {
      detach = true;
    } else if (arg === "--file") {
      if (file !== undefined) throw new Error(`--file names the one Task; pass it once.\n${USAGE}`);
      file = readFlagValue(argv, i + 1, "--file");
      i++;
    } else if (arg === "--context") {
      context.push(readFlagValue(argv, i + 1, "--context"));
      i++;
    } else if (arg === "--prompt") {
      if (template !== undefined) throw new Error(`--prompt names one template; pass it once.\n${USAGE}`);
      template = readFlagValue(argv, i + 1, "--prompt");
      i++;
    } else if (arg === "--base") {
      base = readFlagValue(argv, i + 1, "--base");
      i++;
    } else if (arg === "--name") {
      name = readFlagValue(argv, i + 1, "--name");
      i++;
    } else if (arg === "--continue") {
      continued = readFlagValue(argv, i + 1, "--continue");
      i++;
    } else if (arg === "--gate") {
      gates.push(readFlagValue(argv, i + 1, "--gate"));
      i++;
    } else if (arg === "--max-iterations") {
      maxIterations = readIntFlagValue(argv, i + 1, "--max-iterations");
      i++;
    } else if (arg === "--timeout") {
      timeoutMinutes = readIntFlagValue(argv, i + 1, "--timeout");
      i++;
    } else if (arg === "--network") {
      network = readNetworkFlagValue(argv, i + 1);
      i++;
    } else if (arg === "--adapter") {
      adapterName = readAdapterFlagValue(argv, i + 1);
      i++;
    } else if (!arg.startsWith("--")) {
      tasks.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }

  if (file !== undefined && tasks.length > 0) {
    throw new Error(`--file is the Task; it cannot be combined with a Task phrase.\n${USAGE}`);
  }
  if (file === undefined && tasks.length === 0) {
    throw new Error(USAGE);
  }
  if (continued !== undefined) {
    const refused = [
      name !== undefined && "--name",
      base !== undefined && "--base",
      detach && "--detach",
      tasks.length > 1 && `${tasks.length} Tasks`,
    ].find((flag): flag is string => typeof flag === "string");
    if (refused !== undefined) {
      throw new Error(
        `--continue takes a Run up again on its own branch and base, with one request; it cannot be combined with ${refused}.\n${USAGE}`,
      );
    }
  }
  if (tasks.length > 1 && name !== undefined) {
    throw new Error(`--name names one branch; it cannot be used with ${tasks.length} Tasks.\n${USAGE}`);
  }
  if (detach && tasks.length > 1) {
    throw new Error(`--detach backgrounds one Run; run one \`crisol run --detach\` per Task.\n${USAGE}`);
  }
  if (detach && json) {
    throw new Error(
      `--detach prints only the run id; the Run result goes to result.json, and \`crisol status\` shows it.\n${USAGE}`,
    );
  }

  return {
    tasks,
    file,
    context,
    template,
    json,
    detach,
    base,
    name,
    continue: continued,
    gates,
    maxIterations,
    timeoutMinutes,
    network,
    adapterName,
  };
}

/** The host comes from whatever the agent sent, so only a plain hostname is ever printed unquoted. */
export function formatBlockedAdvice(blocked: readonly Blocked[], allowlist: readonly string[]): string {
  return blocked
    .map((entry) => {
      const times = entry.count === 1 ? "1 attempt" : `${entry.count} attempts`;
      const plain = isPlainHostname(entry.host);
      const shown = plain ? entry.host : JSON.stringify(entry.host);
      if (entry.port !== undefined) {
        return (
          `Blocked: ${shown}:${entry.port} (${times}). Only HTTPS on 443 and plain HTTP on 80 ` +
          "leave the Sandbox, whatever the Allowlist names."
        );
      }
      if (!plain) {
        return `Blocked: ${shown} (${times}). The Allowlist names plain hostnames only, so there is nothing to allow.`;
      }
      if (isInternalHostname(entry.host)) {
        return `Blocked: ${shown} (${times}). It names a host inside your machine or network, which the Allowlist never opens.`;
      }
      if (allowlist.includes(entry.host)) {
        return (
          `Blocked: ${shown} (${times}). It is already on the Allowlist; the request was refused ` +
          "for its form, not its host."
        );
      }
      return (
        `Blocked: ${shown} (${times}). Allow it for every repo, or for this repo only, with:\n` +
        `  crisol allow ${shown}\n` +
        `  crisol allow ${shown} --repo`
      );
    })
    .join("\n");
}

/** Lines to paste, never a question: the user copies only the hosts the repo really needs. */
export function formatLearnedHosts(hosts: readonly string[]): string {
  const count = hosts.length === 1 ? "1 host" : `${hosts.length} hosts`;
  return (
    `This learn Run reached ${count} neither built in nor on this repo's Allowlist. ` +
    "Add the ones the repo needs with:\n" +
    hosts.map((host) => `  crisol allow ${host} --repo`).join("\n")
  );
}

function describeAllow({ outcome, host }: { outcome: AllowOutcome; host: string }, level: string, file: string): string {
  if (outcome === "added") return `Added ${host} to the ${level} Allowlist (${file}).`;
  if (outcome === "already") return `${host} is already on the ${level} Allowlist (${file}).`;
  return `${host} is on the built-in Allowlist already.`;
}

function runAllowCommand(rest: string[]): number {
  const toRepo = rest.includes("--repo");
  const hosts = rest.filter((arg) => arg !== "--repo");
  if (hosts.length !== 1 || hosts[0]!.startsWith("--")) {
    process.stderr.write(`${ALLOW_USAGE}\n`);
    return 1;
  }
  const host = hosts[0]!;
  try {
    if (!toRepo) {
      const home = crisolHome();
      console.log(describeAllow(addToUserAllowlist(home, host), "user", userAllowlistPath(home)));
      return 0;
    }
    const hostRepoPath = discoverGitRoot(process.cwd());
    if (!hostRepoPath) throw new Error(`Not inside a git repo: ${process.cwd()}. --repo edits the repo you run it in.`);
    const added = addToRepoAllowlist(hostRepoPath, host);
    const file = repoAllowlistPath(hostRepoPath);
    console.log(describeAllow(added, "repo", file) + (added.outcome === "added" ? " Commit it to share it." : ""));
    return 0;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

/** An `AggregateError`'s own `.message` drops its causes. */
export function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = error.errors
      .map((cause) => `  - ${cause instanceof Error ? cause.message : String(cause)}`)
      .join("\n");
    return `${error.message}\n${causes}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Arguments are checked first, so a usage error never reaches the real `claude setup-token`. */
async function runAuthCommand(rest: string[]): Promise<number> {
  if (rest.length > 0) {
    process.stderr.write(`Unexpected argument: ${rest[0]}\n${AUTH_USAGE}\n`);
    return 1;
  }
  try {
    await runAuth();
    console.log(`Stored ${CLAUDE_TOKEN_SECRET_NAME} in Crisol's Keychain entry.`);
    return 0;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

function formatOutcome(outcome: RecoverOutcome): string {
  switch (outcome.kind) {
    case "recovered":
      return `Run ${outcome.run}: recovered ${outcome.branch} into ${outcome.host} at ${outcome.sha.slice(0, 7)}.`;
    case "live":
      return `Run ${outcome.run}: live, left alone.`;
    case "skipped":
      return `Run ${outcome.run}: skipped, ${outcome.why}.`;
    case "failed":
      return `Run ${outcome.run}: FAILED, ${outcome.error}`;
    case "up-to-date":
      return `Run ${outcome.run}: up to date.`;
    case "never-cut":
      return `Run ${outcome.run}: ended before cutting a branch.`;
  }
}

async function runRecoverCommand(rest: string[]): Promise<number> {
  if (rest.length > 0) {
    process.stderr.write(`Unexpected argument: ${rest[0]}\n${RECOVER_USAGE}\n`);
    return 1;
  }
  const report = await recover(crisolHome());
  if (report.dockerWarning) process.stderr.write(`${report.dockerWarning}\n`);
  for (const warning of report.networkWarnings) process.stderr.write(`Warning: ${warning}\n`);
  const shown = report.outcomes.filter((outcome) => outcome.kind !== "up-to-date" && outcome.kind !== "never-cut");
  if (shown.length === 0) {
    console.log("Nothing to recover.");
    return 0;
  }
  let exitCode = 0;
  for (const outcome of shown) {
    if (outcome.kind === "failed") {
      exitCode = 1;
      process.stderr.write(`${formatOutcome(outcome)}\n`);
    } else {
      console.log(formatOutcome(outcome));
    }
  }
  return exitCode;
}

function formatEntry(entry: RunEntry): string {
  if (entry.state === "dead") return `${entry.run}  ${entry.state.padEnd(13)}  ${entry.branch}`;
  if (entry.state !== "finished") {
    const pid = entry.pid !== undefined ? `  pid ${entry.pid}` : "";
    return `${entry.run}  ${entry.state.padEnd(13)}  ${entry.branch}${pid}`;
  }
  const { result } = entry;
  const reason = result.reason !== undefined ? `  ${result.reason}` : "";
  return `${entry.run}  ${result.status.padEnd(13)}  ${result.branch}${reason}`;
}

function runStatusCommand(rest: string[]): number {
  if (rest.length > 0) {
    process.stderr.write(`Unexpected argument: ${rest[0]}\n${STATUS_USAGE}\n`);
    return 1;
  }
  const entries = listRuns(crisolHome());
  console.log(entries.length === 0 ? "No Runs." : entries.map(formatEntry).join("\n"));
  return 0;
}

function runLogsCommand(rest: string[]): number {
  if (rest.length !== 1) {
    process.stderr.write(`${LOGS_USAGE}\n`);
    return 1;
  }
  const id = rest[0]!;
  const log = readRunLog(id, crisolHome());
  if (log === undefined) {
    process.stderr.write(`No Run ${JSON.stringify(id)}. \`crisol status\` lists every Run.\n`);
    return 1;
  }
  process.stdout.write(log);
  return 0;
}

/** An unset stdin behaves like an immediate EOF, so a script that answers nothing reads as `""`. */
async function readStdinLine(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk.toString("utf8");
    if (data.includes("\n")) break;
  }
  const newline = data.indexOf("\n");
  return (newline === -1 ? data : data.slice(0, newline)).trim();
}

async function readConfirmation(): Promise<boolean> {
  const answer = (await readStdinLine()).toLowerCase();
  return answer === "y" || answer === "yes";
}

function formatGcCandidate(candidate: { run: string; branch: string; sizeBytes: number }): string {
  return `  ${candidate.run}  ${candidate.branch}  ~${formatGb(candidate.sizeBytes)}`;
}

/** The other skip kinds would nag about every too-young Run on every call. */
function reportRefusal(skip: GcSkip): void {
  if (
    skip.kind === "branch-moved" ||
    skip.kind === "host-missing" ||
    skip.kind === "in-use" ||
    skip.kind === "awaits-continuation"
  ) {
    process.stderr.write(`Run ${skip.run}: refused, ${skip.why}.\n`);
  }
}

async function runGcCommand(rest: string[]): Promise<number> {
  const includeFailed = rest.includes("--include-failed");
  const unknown = rest.find((arg) => arg !== "--include-failed");
  if (unknown !== undefined) {
    process.stderr.write(`Unknown argument: ${unknown}\n${GC_USAGE}\n`);
    return 1;
  }

  const home = crisolHome();
  const plan = planGc(home, { includeFailed });
  for (const skip of plan.skipped) reportRefusal(skip);

  if (plan.collectable.length === 0) {
    console.log("Nothing to collect.");
    reconcileTrackedSize(home);
    return 0;
  }

  const totalBytes = plan.collectable.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
  console.log(
    `${plan.collectable.length} Run(s) ready to collect, freeing ~${formatGb(totalBytes)}:\n` +
      plan.collectable.map(formatGcCandidate).join("\n"),
  );
  process.stdout.write("Delete these Run dirs? [y/N] ");
  if (!(await readConfirmation())) {
    console.log("Nothing deleted.");
    for (const candidate of plan.collectable) candidate.release();
    reconcileTrackedSize(home);
    return 0;
  }

  for (const candidate of plan.collectable) {
    try {
      collectRun(candidate.run, home);
    } finally {
      candidate.release();
    }
    console.log(`Run ${candidate.run}: collected, freed ~${formatGb(candidate.sizeBytes)}.`);
  }
  reconcileTrackedSize(home);
  return 0;
}

function describeInit(report: InitReport): string[] {
  const lines: string[] = [];
  if (report.config === "kept") {
    lines.push(`${REPO_CONFIG_FILE} already exists; left as is.`);
  } else if (report.gates.length === 0) {
    lines.push(`Created ${REPO_CONFIG_FILE} with no Gates: package.json has no typecheck, lint or test script.`);
  } else {
    lines.push(`Created ${REPO_CONFIG_FILE} with Gates: ${report.gates.join(", ")}.`);
  }
  lines.push(
    report.network === "kept"
      ? `${REPO_ALLOWLIST_FILE} already exists; left as is.`
      : `Created ${REPO_ALLOWLIST_FILE}, empty: the repo level of the Allowlist.`,
  );
  const { file, outcome } = report.instructions;
  if (outcome === "already") lines.push(`${file} already declares a ${SANDBOX_HEADING} block; left as is.`);
  else if (outcome === "created") lines.push(`Created ${file} with a ${SANDBOX_HEADING} block.`);
  else lines.push(`Appended a ${SANDBOX_HEADING} block to ${file}.`);
  return lines;
}

async function runInitCommand(rest: string[]): Promise<number> {
  let adapterName: AdapterName = "claude-code";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "--adapter") {
      process.stderr.write(`Unexpected argument: ${rest[i]}\n${INIT_USAGE}\n`);
      return 1;
    }
    try {
      adapterName = readAdapterFlagValue(rest, i + 1);
    } catch (error) {
      process.stderr.write(`${formatError(error)}\n`);
      return 1;
    }
    i++;
  }

  const hostRepoPath = discoverGitRoot(process.cwd());
  if (!hostRepoPath) {
    process.stderr.write(`Not inside a git repo: ${process.cwd()}. \`crisol init\` prepares the repo you run it in.\n`);
    return 1;
  }
  try {
    for (const line of describeInit(initRepo(hostRepoPath))) console.log(line);
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }

  process.stdout.write("Start a first learn Run now, to collect the hosts this repo reaches? [y/N] ");
  if (!(await readConfirmation())) {
    console.log("No learn Run. `crisol run --network learn` starts one later. Commit .crisol/ to share it.");
    return 0;
  }

  const interrupt = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, (name) => interrupt.abort(name));
  let result: RunResult | undefined;
  let failure: unknown;
  try {
    result = await run({
      cwd: hostRepoPath,
      task: LEARN_TASK,
      network: "learn",
      // One pass: a red Gate still shows its hosts, and resuming the agent would learn nothing new.
      maxIterations: 1,
      adapter: createAdapter(adapterName),
      onWarning: (warning) => process.stderr.write(`Warning: ${warning}\n`),
      signal: interrupt.signal,
    });
  } catch (error) {
    failure = error;
    result = (error as RunFailure | undefined)?.result;
    process.stderr.write(`${formatError(error)}\n`);
  }
  if (result === undefined) return 1;

  console.log(`Run ${result.run}: branch ${result.branch}, status ${result.status}.`);
  let added: string[];
  try {
    added = writeLearnedHosts(hostRepoPath, result);
  } catch (error) {
    process.stderr.write(`Cannot write the learned hosts to ${REPO_ALLOWLIST_FILE}: ${formatError(error)}\n`);
    return 1;
  }
  console.log(
    added.length === 0
      ? "The learn Run reached no host beyond the built-in Allowlist and this repo's level."
      : added.map((host) => `Added ${host} to the repo Allowlist (${REPO_ALLOWLIST_FILE}).`).join("\n"),
  );
  console.log("Commit .crisol/ to share it.");
  return failure === undefined ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  assertSupportedPlatform();

  const [command, ...rest] = argv;
  if (command === "--version") {
    console.log(packageJson.version);
    return 0;
  }
  if (command === "auth") {
    return runAuthCommand(rest);
  }
  if (command === "recover") {
    return runRecoverCommand(rest);
  }
  if (command === "status") {
    return runStatusCommand(rest);
  }
  if (command === "logs") {
    return runLogsCommand(rest);
  }
  if (command === "allow") {
    return runAllowCommand(rest);
  }
  if (command === "gc") {
    return runGcCommand(rest);
  }
  if (command === "init") {
    return runInitCommand(rest);
  }
  if (command !== "run") {
    process.stderr.write(
      `${USAGE}\n${ALLOW_USAGE}\n${AUTH_USAGE}\n${RECOVER_USAGE}\n${STATUS_USAGE}\n${LOGS_USAGE}\n${GC_USAGE}\n${INIT_USAGE}\n${VERSION_USAGE}\n`,
    );
    return 1;
  }

  let args: ParsedRunArgs;
  try {
    args = parseRunArgs(rest);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const handoff = takeDetachedHandoff();
  const runOptions: Omit<RunOptions, "task"> = {
    cwd: process.cwd(),
    template: args.template,
    context: args.context,
    base: handoff?.base ?? args.base,
    baseSha: handoff?.baseSha,
    name: args.name,
    continue: args.continue,
    gates: args.gates,
    maxIterations: args.maxIterations,
    ceilingMs: args.timeoutMinutes !== undefined ? args.timeoutMinutes * 60 * 1000 : undefined,
    network: args.network,
    // Deferred for --continue: run() resolves the Run's recorded Adapter once it knows which Run is named.
    adapter:
      args.adapterName !== undefined
        ? createAdapter(args.adapterName)
        : args.continue !== undefined
          ? undefined
          : createAdapter("claude-code"),
    adapterByName: createAdapter,
  };

  if (args.detach) {
    try {
      const { id, pid } = await detachRun(
        { ...runOptions, task: args.tasks[0], file: args.file },
        ["run", ...rest.filter((arg) => arg !== "--detach")],
      );
      console.log(id);
      process.stderr.write(
        `Run ${id} detached as pid ${pid}. \`crisol status\` shows it; \`crisol logs ${id}\` prints its log; ` +
          `\`kill ${pid}\` stops it.\n`,
      );
      return 0;
    } catch (error) {
      process.stderr.write(`${formatError(error)}\n`);
      return 1;
    }
  }

  // Stops Runs still queued for a Slot, and is also how a Run learns of a signal that landed
  // as it left the queue, before its own handlers were armed.
  const interrupt = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => interrupt.abort(signal);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal);

  // A warning `onWarning` already printed is in the Run result too; printing it again would read as two.
  const shownWarnings = new Set<string>();
  const options: Omit<RunOptions, "task"> = {
    ...runOptions,
    detached: handoff && { run: handoff.run, lockFd: handoff.lockFd },
    onSlotWait: (maxParallel) =>
      process.stderr.write(`Waiting for a free Slot (max_parallel = ${maxParallel})…\n`),
    onWarning: (warning) => {
      shownWarnings.add(warning);
      process.stderr.write(`Warning: ${warning}\n`);
    },
    onUnguarded: (line) => process.stderr.write(`${line}\n`),
    onAdapterInherited: (adapterName, runId) =>
      process.stderr.write(`Continuing Run ${runId} with Adapter ${adapterName} (recorded by the Run).\n`),
    // Shared across a fan-out's Runs, so this also gives up a sibling still waiting for a Slot.
    onProviderFailure: (reason) => interrupt.abort(reason),
    signal: interrupt.signal,
  };

  let settled: PromiseSettledResult<RunResult>[];
  try {
    settled =
      args.tasks.length <= 1
        ? await Promise.allSettled([run({ ...options, task: args.tasks[0], file: args.file })])
        : await runFanOut(args.tasks, options);
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }

  // Each Run already read the Allowlist before it started; a level edited since only shifts advice.
  const hostRepoPath = discoverGitRoot(process.cwd());
  let allowlist: readonly string[] = BUILT_IN_ALLOWLIST;
  let baseline: readonly string[] = BUILT_IN_ALLOWLIST;
  let baselineError: unknown;
  try {
    if (hostRepoPath) allowlist = mergedAllowlist(crisolHome(), hostRepoPath);
  } catch {}
  try {
    if (hostRepoPath) baseline = learnBaseline(hostRepoPath);
  } catch (error) {
    baselineError = error;
  }

  let exitCode = 0;
  const learned = new Set<string>();
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      const result = outcome.value;
      for (const host of hostsToLearn(result.reached ?? [], baseline)) learned.add(host);
      if (args.json) {
        console.log(JSON.stringify(result));
      } else {
        const summary = `Run ${result.run}: branch ${result.branch}, status ${result.status}.`;
        const advice = formatBlockedAdvice(result.blocked, allowlist);
        console.log(advice.length > 0 ? `${summary}\n${advice}` : summary);
        for (const warning of result.warnings) {
          if (!shownWarnings.has(warning)) process.stderr.write(`Warning: Run ${result.run}: ${warning}\n`);
        }
      }
    } else {
      exitCode = 1;
      const prefix = args.tasks.length > 1 ? `Task ${JSON.stringify(args.tasks[index])}: ` : "";
      process.stderr.write(`${prefix}${formatError(outcome.reason)}\n`);
      // The Run still computed and wrote a result (a provider failure, an interruption, a red
      // Gate that also lost Fetch-back…) — `--json` prints it even though the Run failed.
      const failedResult = (outcome.reason as RunFailure | undefined)?.result;
      if (args.json && failedResult !== undefined) console.log(JSON.stringify(failedResult));
    }
  });
  // --json is a machine's contract: one Run result per line, and `reached` is already in it.
  if (!args.json && learned.size > 0) {
    // Proposals measured against a level that would not parse would include hosts already on it,
    // and pasting them would fail on the same line.
    if (baselineError === undefined) console.log(formatLearnedHosts([...learned]));
    else process.stderr.write(`Cannot propose hosts for the repo level: ${formatError(baselineError)}\n`);
  }
  // Best-effort: a disk-usage check must never fail a Run that otherwise finished cleanly.
  try {
    const threshold = resolveGcWarnBytes(readGlobalConfig(crisolHome()));
    const sizeWarning = formatSizeWarning(trackedRunsSizeBytes(crisolHome()), threshold);
    if (sizeWarning !== undefined) process.stderr.write(`Warning: ${sizeWarning}\n`);
  } catch {}
  return exitCode;
}

// So a test can import `formatError` without running `main()` against the runner's argv.
if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}
