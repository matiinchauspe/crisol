import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The repo's own `.crisol/config.toml` — the middle rung of the Gate
 * ladder. Read from the HOST repo's working tree, the same place every
 * other pre-flight check in `run.ts` already reads from (identity, Docker
 * reachability) — never from the Clone, which does not exist yet at this
 * point in a Run.
 *
 * A missing file, or a file with no `gates` key, both yield `[]`
 * silently: an unconfigured repo is not an error, it is the "none" rung.
 */
export function readRepoGates(hostRepoPath: string): string[] {
  const configPath = path.join(hostRepoPath, ".crisol", "config.toml");
  if (!existsSync(configPath)) return [];
  return parseGatesArray(readFileSync(configPath, "utf8"));
}

const GATES_LINE = /^[ \t]*gates[ \t]*=[ \t]*\[(.*)\][ \t]*$/m;
const QUOTED_STRING = /"((?:[^"\\]|\\.)*)"/g;

/**
 * Parses a single-line `gates = ["bun test", "bun run typecheck"]` out of a
 * `.crisol/config.toml`-shaped text. Exported for a direct unit test — the
 * parsing itself needs no filesystem. Deliberately narrow: only a
 * SINGLE-LINE array of double-quoted strings is recognised; a multi-line
 * array, a different key, or anything else in the file is silently
 * ignored rather than rejected, so a repo that later adds `network = […]`
 * or `env = […]` alongside `gates = […]` is not broken by this parser.
 */
export function parseGatesArray(text: string): string[] {
  const match = GATES_LINE.exec(text);
  if (!match) return [];
  const body = match[1] ?? "";
  const items: string[] = [];
  QUOTED_STRING.lastIndex = 0;
  let item: RegExpExecArray | null;
  while ((item = QUOTED_STRING.exec(body)) !== null) {
    items.push((item[1] ?? "").replace(/\\"/g, '"'));
  }
  return items;
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/** A positive integer string (no zero, no sign, no decimal) — shared by the CLI's own flag validation (`cli.ts`) and `extractIntKey` below, so a flag and a config-file key reject the same values the same way. */
export function parsePositiveInteger(raw: string): number | undefined {
  return POSITIVE_INTEGER.test(raw) ? Number.parseInt(raw, 10) : undefined;
}

/** `~/.crisol/config`'s own two keys — the ceiling's global rung. Both optional: a key a Run never sets falls through to the built-in default. */
export interface GlobalConfig {
  maxIterations?: number;
  timeoutMinutes?: number;
}

function intKeyLine(key: string): RegExp {
  return new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(\\S+)`, "m");
}

function extractIntKey(text: string, key: string, sourcePath: string): number | undefined {
  const match = intKeyLine(key).exec(text);
  if (!match) return undefined;
  const raw = match[1] ?? "";
  const value = parsePositiveInteger(raw);
  if (value === undefined) {
    throw new Error(`${sourcePath}: "${key}" must be a positive integer, got "${raw}".`);
  }
  return value;
}

/**
 * Parses `~/.crisol/config`'s TOML-shaped text for `max_iterations` and
 * `timeout_minutes` — the same hand-rolled, single-key-per-line approach
 * as `parseGatesArray` above. Any other key — a future `max_parallel`,
 * say — is silently ignored, never rejected. `sourcePath` only names the
 * source in a thrown error, so a unit test can pass a fake one without
 * touching disk.
 */
export function parseGlobalConfig(text: string, sourcePath: string): GlobalConfig {
  const config: GlobalConfig = {};
  const maxIterations = extractIntKey(text, "max_iterations", sourcePath);
  if (maxIterations !== undefined) config.maxIterations = maxIterations;
  const timeoutMinutes = extractIntKey(text, "timeout_minutes", sourcePath);
  if (timeoutMinutes !== undefined) config.timeoutMinutes = timeoutMinutes;
  return config;
}

/**
 * Reads `path.join(home, "config")` — `home` is always the resolved
 * `crisolHome()` (or a test's own temp home), never the host repo, which is
 * what `readRepoGates` reads instead. A missing file is not an error: it is
 * the "no override" case, so every knob falls through to the built-in
 * default.
 */
export function readGlobalConfig(home: string): GlobalConfig {
  const configPath = path.join(home, "config");
  if (!existsSync(configPath)) return {};
  return parseGlobalConfig(readFileSync(configPath, "utf8"), configPath);
}
