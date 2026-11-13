#!/usr/bin/env bun
import { ClaudeCodeAdapter } from "./adapters/claude-code";
import { runAuth } from "./auth";
import { parsePositiveInteger } from "./config";
import { crisolHome } from "./paths";
import { assertSupportedPlatform } from "./platform";
import { detachRun, takeDetachedHandoff } from "./detach";
import { recover } from "./recover";
import type { RecoverOutcome } from "./recover";
import { run, runFanOut } from "./run";
import { listRuns, readRunLog } from "./runs";
import type { RunEntry } from "./runs";
import type { RunOptions, RunResult } from "./run";
import { CLAUDE_TOKEN_SECRET_NAME } from "./secret-store";

const USAGE =
  'Usage: crisol run "<task>"... [--json | --detach] [--base <ref>] [--name <branch>] [--gate <cmd>]... ' +
  "[--max-iterations <n>] [--timeout <minutes>] [--adapter <fake|claude-code>]";

const AUTH_USAGE = "Usage: crisol auth";

const RECOVER_USAGE = "Usage: crisol recover";

const STATUS_USAGE = "Usage: crisol status";

const LOGS_USAGE = "Usage: crisol logs <run>";

const ADAPTER_NAMES = ["fake", "claude-code"] as const;
type AdapterName = (typeof ADAPTER_NAMES)[number];

interface ParsedRunArgs {
  /** More than one fans out into independent Runs from the same base. */
  tasks: string[];
  json: boolean;
  detach: boolean;
  base?: string;
  name?: string;
  gates: string[];
  maxIterations?: number;
  timeoutMinutes?: number;
  adapterName: AdapterName;
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

function parseRunArgs(argv: string[]): ParsedRunArgs {
  const tasks: string[] = [];
  let json = false;
  let detach = false;
  let base: string | undefined;
  let name: string | undefined;
  const gates: string[] = [];
  let maxIterations: number | undefined;
  let timeoutMinutes: number | undefined;
  let adapterName: AdapterName = "fake";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--detach") {
      detach = true;
    } else if (arg === "--base") {
      base = readFlagValue(argv, i + 1, "--base");
      i++;
    } else if (arg === "--name") {
      name = readFlagValue(argv, i + 1, "--name");
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
    } else if (arg === "--adapter") {
      adapterName = readAdapterFlagValue(argv, i + 1);
      i++;
    } else if (!arg.startsWith("--")) {
      tasks.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }

  if (tasks.length === 0) {
    throw new Error(USAGE);
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

  return { tasks, json, detach, base, name, gates, maxIterations, timeoutMinutes, adapterName };
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

async function main(argv: string[]): Promise<number> {
  assertSupportedPlatform();

  const [command, ...rest] = argv;
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
  if (command !== "run") {
    process.stderr.write(`${USAGE}\n${AUTH_USAGE}\n${RECOVER_USAGE}\n${STATUS_USAGE}\n${LOGS_USAGE}\n`);
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
    base: handoff?.base ?? args.base,
    baseSha: handoff?.baseSha,
    name: args.name,
    gates: args.gates,
    maxIterations: args.maxIterations,
    ceilingMs: args.timeoutMinutes !== undefined ? args.timeoutMinutes * 60 * 1000 : undefined,
    adapter: args.adapterName === "claude-code" ? new ClaudeCodeAdapter() : undefined,
  };

  if (args.detach) {
    try {
      const { id, pid } = await detachRun(
        { ...runOptions, task: args.tasks[0]! },
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

  const options: Omit<RunOptions, "task"> = {
    ...runOptions,
    detached: handoff && { run: handoff.run, lockFd: handoff.lockFd },
    onSlotWait: (maxParallel) =>
      process.stderr.write(`Waiting for a free Slot (max_parallel = ${maxParallel})…\n`),
    onWarning: (warning) => process.stderr.write(`Warning: ${warning}\n`),
    signal: interrupt.signal,
  };

  let settled: PromiseSettledResult<RunResult>[];
  try {
    settled =
      args.tasks.length === 1
        ? await Promise.allSettled([run({ ...options, task: args.tasks[0]! })])
        : await runFanOut(args.tasks, options);
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }

  let exitCode = 0;
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      const result = outcome.value;
      console.log(
        args.json
          ? JSON.stringify(result)
          : `Run ${result.run}: branch ${result.branch}, status ${result.status}.`,
      );
    } else {
      exitCode = 1;
      const prefix = args.tasks.length > 1 ? `Task ${JSON.stringify(args.tasks[index])}: ` : "";
      process.stderr.write(`${prefix}${formatError(outcome.reason)}\n`);
    }
  });
  return exitCode;
}

// So a test can import `formatError` without running `main()` against the runner's argv.
if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}
