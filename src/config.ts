import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readTextAtCommit } from "./git";
import { REPO_CONFIG_FILE } from "./paths";

export function readRepoGates(hostRepoPath: string, baseSha: string): string[] {
  const text = readTextAtCommit(hostRepoPath, baseSha, REPO_CONFIG_FILE);
  return text === undefined ? [] : parseGatesArray(text);
}

/** Names only, never values: each is read from the host's own environment at launch. */
export function readRepoSecretNames(hostRepoPath: string, baseSha: string): string[] {
  const text = readTextAtCommit(hostRepoPath, baseSha, REPO_CONFIG_FILE);
  return text === undefined ? [] : parseSecretNamesArray(text);
}

const QUOTED_STRING = /"((?:[^"\\]|\\.)*)"/g;

function arrayKeyLine(key: string): RegExp {
  return new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\[(.*)\\][ \\t]*$`, "m");
}

/**
 * Only a single-line array of double-quoted strings is recognised, and anything else is ignored
 * rather than rejected, so one key this parser cannot read never breaks another.
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

export function parseGatesArray(text: string): string[] {
  return parseStringArrayKey(text, "gates");
}

export function parseSecretNamesArray(text: string): string[] {
  return parseStringArrayKey(text, "env");
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export function parsePositiveInteger(raw: string): number | undefined {
  return POSITIVE_INTEGER.test(raw) ? Number.parseInt(raw, 10) : undefined;
}

export interface GlobalConfig {
  maxIterations?: number;
  timeoutMinutes?: number;
  maxParallel?: number;
  cpus?: number;
  memory?: string;
  gcWarnBytes?: number;
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

const POSITIVE_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

/** `--cpus` takes a decimal, unlike every other knob here, which is a whole number. */
export function parsePositiveNumber(raw: string): number | undefined {
  if (!POSITIVE_DECIMAL.test(raw)) return undefined;
  const value = Number.parseFloat(raw);
  return value > 0 ? value : undefined;
}

function extractNumberKey(text: string, key: string, sourcePath: string): number | undefined {
  const match = intKeyLine(key).exec(text);
  if (!match) return undefined;
  const raw = match[1] ?? "";
  const value = parsePositiveNumber(raw);
  if (value === undefined) {
    throw new Error(`${sourcePath}: "${key}" must be a positive number, got "${raw}".`);
  }
  return value;
}

const DOCKER_MEMORY_SIZE = /^([0-9]+)([bBkKmMgG]?)$/;

/** `docker run --memory`'s own syntax: a byte count, or one with a `b`/`k`/`m`/`g` suffix. */
export function parseDockerMemorySize(raw: string): string | undefined {
  const match = DOCKER_MEMORY_SIZE.exec(raw);
  if (!match || Number.parseInt(match[1]!, 10) <= 0) return undefined;
  return raw;
}

function extractMemoryKey(text: string, key: string, sourcePath: string): string | undefined {
  const match = intKeyLine(key).exec(text);
  if (!match) return undefined;
  const raw = match[1] ?? "";
  const value = parseDockerMemorySize(raw);
  if (value === undefined) {
    throw new Error(`${sourcePath}: "${key}" must be a Docker memory size (for example "4g"), got "${raw}".`);
  }
  return value;
}

/** Any other key is ignored, never rejected, so one Crisol version reads another's config. */
export function parseGlobalConfig(text: string, sourcePath: string): GlobalConfig {
  const config: GlobalConfig = {};
  const maxIterations = extractIntKey(text, "max_iterations", sourcePath);
  if (maxIterations !== undefined) config.maxIterations = maxIterations;
  const timeoutMinutes = extractIntKey(text, "timeout_minutes", sourcePath);
  if (timeoutMinutes !== undefined) config.timeoutMinutes = timeoutMinutes;
  const maxParallel = extractIntKey(text, "max_parallel", sourcePath);
  if (maxParallel !== undefined) config.maxParallel = maxParallel;
  const cpus = extractNumberKey(text, "cpus", sourcePath);
  if (cpus !== undefined) config.cpus = cpus;
  const memory = extractMemoryKey(text, "memory", sourcePath);
  if (memory !== undefined) config.memory = memory;
  const gcWarnBytes = extractIntKey(text, "gc_warn_bytes", sourcePath);
  if (gcWarnBytes !== undefined) config.gcWarnBytes = gcWarnBytes;
  return config;
}

export function readGlobalConfig(home: string): GlobalConfig {
  const configPath = path.join(home, "config");
  if (!existsSync(configPath)) return {};
  return parseGlobalConfig(readFileSync(configPath, "utf8"), configPath);
}

/** From Crisol's home, never `~/.claude`: the global `~/.claude/CLAUDE.md` never reaches a Run. */
export function readInstructions(home: string): string | undefined {
  const instructionsPath = path.join(home, "instructions.md");
  if (!existsSync(instructionsPath)) return undefined;
  return readFileSync(instructionsPath, "utf8");
}
