#!/usr/bin/env bun
import { parsePositiveInteger } from "./config";
import { assertSupportedPlatform } from "./platform";
import { run } from "./run";

const USAGE =
  'Usage: crisol run "<task>" [--json] [--base <ref>] [--name <branch>] [--gate <cmd>]... ' +
  "[--max-iterations <n>] [--timeout <minutes>]";

interface ParsedRunArgs {
  task: string;
  json: boolean;
  base?: string;
  name?: string;
  /** `--gate`, repeatable — the Gate ladder's strongest rung. */
  gates: string[];
  maxIterations?: number;
  /** Minutes; converted to ms for `RunOptions.ceilingMs`. */
  timeoutMinutes?: number;
}

/** A missing value, or one that looks like another flag, is a usage error — never silently treated as "no value given" (which would let `--base --json` quietly run with no base). */
function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.\n${USAGE}`);
  }
  return value;
}

/** Same guard as `readFlagValue`, plus a positive-integer check — never silently falls back on an unparseable value. */
function readIntFlagValue(argv: string[], index: number, flag: string): number {
  const raw = readFlagValue(argv, index, flag);
  const value = parsePositiveInteger(raw);
  if (value === undefined) {
    throw new Error(`${flag} must be a positive integer, got "${raw}".\n${USAGE}`);
  }
  return value;
}

function parseRunArgs(argv: string[]): ParsedRunArgs {
  let task: string | undefined;
  let json = false;
  let base: string | undefined;
  let name: string | undefined;
  const gates: string[] = [];
  let maxIterations: number | undefined;
  let timeoutMinutes: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
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
    } else if (task === undefined && !arg.startsWith("--")) {
      task = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }

  if (task === undefined) {
    throw new Error(USAGE);
  }

  return { task, json, base, name, gates, maxIterations, timeoutMinutes };
}

/**
 * An `AggregateError`'s outer `.message` alone drops its underlying causes;
 * this surfaces them. Exported so it can be unit-tested without spawning a
 * real CLI process.
 */
export function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = error.errors
      .map((cause) => `  - ${cause instanceof Error ? cause.message : String(cause)}`)
      .join("\n");
    return `${error.message}\n${causes}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function main(argv: string[]): Promise<number> {
  assertSupportedPlatform();

  const [command, ...rest] = argv;
  if (command !== "run") {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  let args: ParsedRunArgs;
  try {
    args = parseRunArgs(rest);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  try {
    const result = await run({
      task: args.task,
      cwd: process.cwd(),
      base: args.base,
      name: args.name,
      gates: args.gates,
      maxIterations: args.maxIterations,
      ceilingMs: args.timeoutMinutes !== undefined ? args.timeoutMinutes * 60 * 1000 : undefined,
    });
    if (args.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`Run ${result.run}: branch ${result.branch}, status ${result.status}.`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

// Guards the entrypoint so `cli.ts` can be imported in a test (e.g. for `formatError`)
// without running `main()` against the test runner's argv and exiting the process.
if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}
