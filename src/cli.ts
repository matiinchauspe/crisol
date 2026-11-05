#!/usr/bin/env bun
import { assertSupportedPlatform } from "./platform";
import { run } from "./run";

const USAGE = 'Usage: crisol run "<task>" [--json] [--base <ref>] [--name <branch>]';

interface ParsedRunArgs {
  task: string;
  json: boolean;
  base?: string;
  name?: string;
}

/**
 * A missing value, or a value that itself looks like another flag (starts
 * with `--`), is a usage error (fix W6) — never silently treated as "no
 * value given", which would otherwise let `--base --json` quietly run with
 * no base at all instead of refusing.
 */
function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.\n${USAGE}`);
  }
  return value;
}

function parseRunArgs(argv: string[]): ParsedRunArgs {
  let task: string | undefined;
  let json = false;
  let base: string | undefined;
  let name: string | undefined;

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
    } else if (task === undefined && !arg.startsWith("--")) {
      task = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }

  if (task === undefined) {
    throw new Error(USAGE);
  }

  return { task, json, base, name };
}

/**
 * finding 7 (round-2 review): an `AggregateError` (W4's double-failure
 * shape — primary error AND Fetch-back both failed) was printed via its
 * own outer `.message` alone, dropping both underlying causes. Exported so
 * it can be unit-tested directly without spawning a real CLI process.
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
  // The ticket's own wording: exits AT ONCE, before any argument parsing.
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

// `import.meta.main` guards the entrypoint side effect so `cli.ts` can be
// imported from a test (e.g. for `formatError`) without running `main()`
// against the test runner's own argv and exiting the whole process.
if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}
