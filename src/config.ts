import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The middle rung of the Gate ladder. Read from the HOST repo's working tree —
 * never the Clone, which doesn't exist yet at this point in a Run. A missing file
 * or a file with no `gates` key both yield `[]`: an unconfigured repo is the "none"
 * rung, not an error.
 */
export function readRepoGates(hostRepoPath: string): string[] {
  const configPath = path.join(hostRepoPath, ".crisol", "config.toml");
  if (!existsSync(configPath)) return [];
  return parseGatesArray(readFileSync(configPath, "utf8"));
}

/**
 * `.crisol/config.toml`'s `env = [...]` — secret env var NAMES a repo declares (never
 * values), read from the host's own environment at launch. Same file, same missing-file
 * rule as `readRepoGates`.
 */
export function readRepoSecretNames(hostRepoPath: string): string[] {
  const configPath = path.join(hostRepoPath, ".crisol", "config.toml");
  if (!existsSync(configPath)) return [];
  return parseSecretNamesArray(readFileSync(configPath, "utf8"));
}

const QUOTED_STRING = /"((?:[^"\\]|\\.)*)"/g;

function arrayKeyLine(key: string): RegExp {
  return new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\[(.*)\\][ \\t]*$`, "m");
}

/**
 * Shared by every single-line, double-quoted string-array key `.crisol/config.toml`
 * carries (`gates`, `env`, ...). Deliberately narrow: only a single-line array is
 * recognised; anything else is silently ignored rather than rejected, so a repo adding
 * one key doesn't break a parse of another already there.
 */
function parseStringArrayKey(text: string, key: string): string[] {
  const match = arrayKeyLine(key).exec(text);
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

/** Exported for a direct unit test — parsing needs no filesystem. */
export function parseGatesArray(text: string): string[] {
  return parseStringArrayKey(text, "gates");
}

/** Exported for a direct unit test — parsing needs no filesystem. */
export function parseSecretNamesArray(text: string): string[] {
  return parseStringArrayKey(text, "env");
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/** Shared by the CLI's flag validation and `extractIntKey` below, so both reject the same values the same way. */
export function parsePositiveInteger(raw: string): number | undefined {
  return POSITIVE_INTEGER.test(raw) ? Number.parseInt(raw, 10) : undefined;
}

/** The ceiling's global rung; unset keys fall through to the built-in default. */
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
 * Any other key is silently ignored, never rejected — same forward-compat as
 * `parseGatesArray`. `sourcePath` only names the source in a thrown error, so a
 * unit test can pass a fake one without touching disk.
 */
export function parseGlobalConfig(text: string, sourcePath: string): GlobalConfig {
  const config: GlobalConfig = {};
  const maxIterations = extractIntKey(text, "max_iterations", sourcePath);
  if (maxIterations !== undefined) config.maxIterations = maxIterations;
  const timeoutMinutes = extractIntKey(text, "timeout_minutes", sourcePath);
  if (timeoutMinutes !== undefined) config.timeoutMinutes = timeoutMinutes;
  return config;
}

/** `home`, never the host repo — that's `readRepoGates`. A missing file falls through to the built-in default, not an error. */
export function readGlobalConfig(home: string): GlobalConfig {
  const configPath = path.join(home, "config");
  if (!existsSync(configPath)) return {};
  return parseGlobalConfig(readFileSync(configPath, "utf8"), configPath);
}

/**
 * `~/.crisol/instructions.md` — injected as agent instructions in every Run when present.
 * `home`, like `readGlobalConfig`, never the host repo or `~/.claude`: the global
 * `~/.claude/CLAUDE.md` is never read or mounted. A missing file is the normal case, not
 * an error.
 */
export function readInstructions(home: string): string | undefined {
  const instructionsPath = path.join(home, "instructions.md");
  if (!existsSync(instructionsPath)) return undefined;
  return readFileSync(instructionsPath, "utf8");
}
