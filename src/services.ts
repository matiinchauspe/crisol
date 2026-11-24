import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { removeContainerByName, runDocker } from "./docker";
import type { StopResult } from "./docker";

export interface HealthCheck {
  /** `["CMD", ...]` (exec form), `["CMD-SHELL", "<cmd>"]` (shell form), or `["NONE"]` (disabled). */
  test: readonly string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
}

export interface ServiceSpec {
  name: string;
  image: string;
  environment?: Record<string, string>;
  command?: readonly string[];
  healthcheck?: HealthCheck;
}

const ALLOWED_SERVICE_KEYS = ["image", "environment", "command", "healthcheck"] as const;
const ALLOWED_HEALTHCHECK_KEYS = ["test", "interval", "timeout", "retries", "start_period"] as const;

// `.crisol/services.yml` is a restricted compose file, never arbitrary YAML, so this reads
// exactly the shapes that grammar needs and nothing past it — the same bet config.toml's
// hand-rolled parser already makes on `.crisol/config.toml`.
type YamlNode = string | YamlNode[] | { [key: string]: YamlNode };

interface Line {
  indent: number;
  text: string;
  lineNo: number;
}

/** `#` opens a comment only outside quotes, and only at the start of a line or after whitespace. */
function stripComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function tokenize(text: string): Line[] {
  const lines: Line[] = [];
  const raw = text.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const withoutComment = stripComment(raw[i]!).replace(/\s+$/, "");
    if (withoutComment.trim().length === 0) continue;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    lines.push({ indent, text: withoutComment.trim(), lineNo: i + 1 });
  }
  return lines;
}

/** The first `:` outside quotes that is followed by a space or end of line — a mapping key's own terminator. */
function findKeyColon(text: string): number {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":" && (i + 1 === text.length || text[i + 1] === " ")) return i;
  }
  return -1;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Splits a flow sequence's inner text on commas outside quotes; `[]`'s empty inner yields no items. */
function splitFlowSequence(inner: string): string[] {
  if (inner.trim().length === 0) return [];
  const raw: string[] = [];
  let quote: '"' | "'" | undefined;
  let current = "";
  for (const ch of inner) {
    if (quote !== undefined) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      raw.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  raw.push(current);
  return raw.map(unquote);
}

function parseScalar(raw: string): YamlNode {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return splitFlowSequence(trimmed.slice(1, -1));
  return unquote(trimmed);
}

function isSequenceItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function itemBody(text: string): string {
  return text === "-" ? "" : text.slice(2);
}

function parseMapping(
  lines: readonly Line[],
  index: number,
  blockIndent: number,
  sourcePath: string,
): { value: YamlNode; next: number } {
  const map: Record<string, YamlNode> = {};
  let i = index;
  while (i < lines.length && lines[i]!.indent === blockIndent && !isSequenceItem(lines[i]!.text)) {
    const line = lines[i]!;
    const colon = findKeyColon(line.text);
    if (colon === -1) throw new Error(`${sourcePath}: line ${line.lineNo}: expected "key: value".`);
    const key = unquote(line.text.slice(0, colon));
    const rest = line.text.slice(colon + 1).trim();
    if (rest.length === 0) {
      const next = lines[i + 1];
      if (next !== undefined && next.indent > blockIndent) {
        const nested = parseBlock(lines, i + 1, blockIndent + 1, sourcePath);
        map[key] = nested.value;
        i = nested.next;
      } else {
        map[key] = "";
        i += 1;
      }
    } else {
      map[key] = parseScalar(rest);
      i += 1;
    }
  }
  return { value: map, next: i };
}

function parseBlock(
  lines: readonly Line[],
  index: number,
  minIndent: number,
  sourcePath: string,
): { value: YamlNode; next: number } {
  const first = lines[index];
  if (first === undefined || first.indent < minIndent) {
    throw new Error(`${sourcePath}: expected an indented value after line ${lines[index - 1]?.lineNo ?? 0}.`);
  }
  const blockIndent = first.indent;
  if (isSequenceItem(first.text)) {
    const items: YamlNode[] = [];
    let i = index;
    while (i < lines.length && lines[i]!.indent === blockIndent && isSequenceItem(lines[i]!.text)) {
      items.push(parseScalar(itemBody(lines[i]!.text)));
      i += 1;
    }
    return { value: items, next: i };
  }
  return parseMapping(lines, index, blockIndent, sourcePath);
}

export function parseYamlDocument(text: string, sourcePath: string): YamlNode {
  const lines = tokenize(text);
  if (lines.length === 0) return {};
  return parseBlock(lines, 0, 0, sourcePath).value;
}

function asMapping(node: YamlNode | undefined, context: string, sourcePath: string): Record<string, YamlNode> {
  if (node === undefined || Array.isArray(node) || typeof node !== "object") {
    throw new Error(`${sourcePath}: ${context} must be a mapping.`);
  }
  return node;
}

function asString(node: YamlNode | undefined, context: string, sourcePath: string): string {
  if (typeof node !== "string") throw new Error(`${sourcePath}: ${context} must be a plain scalar.`);
  return node;
}

function asStringArray(node: YamlNode | undefined, context: string, sourcePath: string): string[] {
  if (!Array.isArray(node)) throw new Error(`${sourcePath}: ${context} must be a list.`);
  return node.map((item, i) => asString(item, `${context}[${i}]`, sourcePath));
}

function asPositiveInt(node: YamlNode, context: string, sourcePath: string): number {
  const raw = asString(node, context, sourcePath);
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value <= 0 || String(value) !== raw.trim()) {
    throw new Error(`${sourcePath}: ${context} must be a positive integer, got "${raw}".`);
  }
  return value;
}

/** Compose allows either a mapping (`KEY: value`) or a list of `KEY=VALUE` strings; both land here. */
function parseEnvironment(node: YamlNode, sourcePath: string, serviceName: string): Record<string, string> {
  const context = `service "${serviceName}"'s "environment"`;
  if (Array.isArray(node)) {
    const env: Record<string, string> = {};
    node.forEach((item, i) => {
      const entry = asString(item, `${context}[${i}]`, sourcePath);
      const eq = entry.indexOf("=");
      if (eq === -1) throw new Error(`${sourcePath}: ${context}[${i}] "${entry}" is not "KEY=VALUE".`);
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    });
    return env;
  }
  const map = asMapping(node, context, sourcePath);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    env[key] = asString(value, `${context}.${key}`, sourcePath);
  }
  return env;
}

const USE_A_SHELL = `to run it through a shell, write the command as ["sh", "-c", "…"]`;

/**
 * Compose's own split: compose-go hands a string `command` to go-shellwords with every expansion off.
 * Where compose would cut the command at a shell operator, or pass a command substitution through
 * as literal text, this throws instead: either way the author meant a shell.
 */
export function splitCommandString(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      word += ch === "n" ? "\n" : ch === "t" ? "\t" : ch;
      started = true;
      escaped = false;
    } else if (quote === "'") {
      if (ch === "'") quote = undefined;
      else word += ch;
    } else if (ch === "\\") {
      escaped = true;
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (" \t\r\n".includes(ch)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else if (";&|<>".includes(ch)) {
      throw new Error(`has the shell operator "${ch}", which compose would cut the command at; ${USE_A_SHELL}.`);
    } else if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
      throw new Error(`has a command substitution, which compose never runs; ${USE_A_SHELL}.`);
    } else if (ch === "(" || ch === ")") {
      throw new Error(`has a bare "${ch}", which compose rejects too; quote it, or write the command as a list.`);
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote !== undefined || escaped) {
    throw new Error("has an unclosed quote or a trailing backslash; close it, or write the command as a list.");
  }
  if (started) words.push(word);
  return words;
}

function parseCommand(node: YamlNode, sourcePath: string, serviceName: string): string[] {
  const context = `service "${serviceName}"'s "command"`;
  if (Array.isArray(node)) return asStringArray(node, context, sourcePath);
  if (typeof node !== "string") throw new Error(`${sourcePath}: ${context} must be a list or a single string.`);
  try {
    return splitCommandString(node);
  } catch (error) {
    throw new Error(`${sourcePath}: ${context} ${(error as Error).message}`);
  }
}

function parseHealthcheck(node: YamlNode, sourcePath: string, serviceName: string): HealthCheck {
  const context = `service "${serviceName}"'s "healthcheck"`;
  const map = asMapping(node, context, sourcePath);
  for (const key of Object.keys(map)) {
    if (!(ALLOWED_HEALTHCHECK_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${sourcePath}: ${context} has key "${key}", which is not one of ${ALLOWED_HEALTHCHECK_KEYS.join(", ")}.`);
    }
  }
  // Compose reads a string `test` as `CMD-SHELL` followed by that string.
  const test = typeof map.test === "string" ? ["CMD-SHELL", map.test] : asStringArray(map.test, `${context}.test`, sourcePath);
  const kind = test[0];
  if (kind === undefined) throw new Error(`${sourcePath}: ${context}.test must not be empty.`);
  if (kind !== "CMD" && kind !== "CMD-SHELL" && kind !== "NONE") {
    throw new Error(`${sourcePath}: ${context}.test must start with "CMD", "CMD-SHELL", or "NONE", got "${kind}".`);
  }
  const interval = map.interval !== undefined ? asString(map.interval, `${context}.interval`, sourcePath) : undefined;
  const timeout = map.timeout !== undefined ? asString(map.timeout, `${context}.timeout`, sourcePath) : undefined;
  const startPeriod =
    map.start_period !== undefined ? asString(map.start_period, `${context}.start_period`, sourcePath) : undefined;
  const retries = map.retries !== undefined ? asPositiveInt(map.retries, `${context}.retries`, sourcePath) : undefined;
  return {
    test,
    ...(interval !== undefined ? { interval } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(startPeriod !== undefined ? { startPeriod } : {}),
  };
}

export function parseServicesYaml(text: string, sourcePath: string): ServiceSpec[] {
  const top = asMapping(parseYamlDocument(text, sourcePath), "the top level", sourcePath);
  const badTopKey = Object.keys(top).find((key) => key !== "services");
  if (badTopKey !== undefined) {
    throw new Error(`${sourcePath}: unexpected top-level key "${badTopKey}"; only "services" is read.`);
  }
  const servicesNode = top.services;
  if (servicesNode === undefined || servicesNode === "") return [];

  const servicesMap = asMapping(servicesNode, '"services"', sourcePath);
  return Object.entries(servicesMap).map(([name, node]) => {
    const service = asMapping(node, `service "${name}"`, sourcePath);
    for (const key of Object.keys(service)) {
      if (!(ALLOWED_SERVICE_KEYS as readonly string[]).includes(key)) {
        throw new Error(
          `${sourcePath}: service "${name}" has key "${key}", which is not one of the allowed ` +
            `${ALLOWED_SERVICE_KEYS.join(", ")}.`,
        );
      }
    }
    const image = asString(service.image, `service "${name}"'s "image"`, sourcePath);
    const environment = service.environment !== undefined ? parseEnvironment(service.environment, sourcePath, name) : undefined;
    const command = service.command !== undefined ? parseCommand(service.command, sourcePath, name) : undefined;
    const healthcheck =
      service.healthcheck !== undefined ? parseHealthcheck(service.healthcheck, sourcePath, name) : undefined;
    return {
      name,
      image,
      ...(environment !== undefined ? { environment } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(healthcheck !== undefined ? { healthcheck } : {}),
    };
  });
}

const SERVICES_FILE = path.join(".crisol", "services.yml");

/** Read from the host repo's working tree, like `readRepoGates`: the Clone doesn't exist yet. */
export function readRepoServices(hostRepoPath: string): ServiceSpec[] {
  const servicesPath = path.join(hostRepoPath, SERVICES_FILE);
  if (!existsSync(servicesPath)) return [];
  return parseServicesYaml(readFileSync(servicesPath, "utf8"), servicesPath);
}

function serviceContainerName(id: string, name: string): string {
  return `crisol-svc-${id}-${name}`;
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * `docker run --health-cmd` only ever runs a shell string — the same mechanism as Dockerfile's
 * `HEALTHCHECK CMD <string>` form; there is no CLI flag for the exec/array form `HEALTHCHECK CMD
 * ["a", "b"]` bakes into an image. `CMD-SHELL`'s one argument already is that shell string and
 * passes through verbatim; `CMD`'s argv is quoted and joined, which runs the same program as the
 * exec form would have, as long as no argument depended on shell-less exec semantics (`pg_isready`
 * and `redis-cli ping` do not). `NONE` disables it.
 */
function buildHealthShellCommand(test: readonly string[]): string | undefined {
  const [kind, ...rest] = test;
  if (kind === "CMD-SHELL") return rest[0];
  if (kind === "CMD") return rest.map(shellQuote).join(" ");
  return undefined;
}

function buildHealthArgs(check: HealthCheck | undefined): string[] {
  if (check === undefined || check.test[0] === "NONE") return [];
  const cmd = buildHealthShellCommand(check.test);
  if (cmd === undefined) return [];
  return [
    "--health-cmd",
    cmd,
    ...(check.interval !== undefined ? ["--health-interval", check.interval] : []),
    ...(check.timeout !== undefined ? ["--health-timeout", check.timeout] : []),
    ...(check.retries !== undefined ? ["--health-retries", String(check.retries)] : []),
    ...(check.startPeriod !== undefined ? ["--health-start-period", check.startPeriod] : []),
  ];
}

export function buildServiceRunArgs(id: string, network: string, service: ServiceSpec): string[] {
  const envArgs = Object.entries(service.environment ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  return [
    "docker",
    "run",
    "-d",
    "--init",
    "--network",
    network,
    "--network-alias",
    service.name,
    "--name",
    serviceContainerName(id, service.name),
    "--label",
    `crisol.run=${id}`,
    ...envArgs,
    ...buildHealthArgs(service.healthcheck),
    service.image,
    ...(service.command ?? []),
  ];
}

async function startServiceContainer(id: string, network: string, service: ServiceSpec): Promise<string> {
  const name = serviceContainerName(id, service.name);
  const result = await runDocker(buildServiceRunArgs(id, network, service));
  if (result.exitCode !== 0) {
    throw new Error(`docker run failed for service "${service.name}": ${result.stderr.trim()}`);
  }
  return name;
}

type ServiceState =
  | { kind: "running"; health: string | undefined }
  | { kind: "exited"; exitCode: number }
  | { kind: "gone" }
  | { kind: "unknown" };

async function inspectService(name: string): Promise<ServiceState> {
  const result = await runDocker([
    "docker",
    "inspect",
    "--format",
    "{{.State.Status}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
    name,
  ]);
  if (result.exitCode !== 0) return /no such/i.test(result.stderr) ? { kind: "gone" } : { kind: "unknown" };
  const [status, exitCode, health] = result.stdout.trim().split(" ");
  // An exited container reports its health as `unhealthy` too, so the exit is read first.
  if (status === "exited" || status === "dead") return { kind: "exited", exitCode: Number(exitCode) };
  return { kind: "running", health: health !== undefined && health.length > 0 ? health : undefined };
}

const LOG_TAIL_LINES = 20;

/** `docker logs` keeps the container's stdout and stderr apart, so their interleaving is lost. */
async function tailLogs(name: string): Promise<string> {
  const result = await runDocker(["docker", "logs", "--tail", String(LOG_TAIL_LINES), name]);
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

async function exitedMessage(service: string, container: string, exitCode: number): Promise<string> {
  const logs = await tailLogs(container);
  const tail = logs.length > 0 ? ` Its last log lines:\n${logs}` : " It logged nothing.";
  return `Service "${service}" exited with code ${exitCode} before it became healthy.${tail}`;
}

const HEALTH_POLL_INTERVAL_MS = 500;
/**
 * A generous backstop only: each service's own `--health-interval`/`--health-retries` is what
 * actually settles `starting` to `healthy` or `unhealthy` (verified live — a `retries: 1`,
 * `interval: 1s` service goes `unhealthy` in about two seconds). This ceiling exists only against
 * a service whose own healthcheck configuration never terminates.
 */
const HEALTH_WAIT_CEILING_MS = 10 * 60 * 1000;

export interface ServiceRuntime {
  names: readonly string[];
  /**
   * Throws naming the first gated service to exit, vanish or turn `unhealthy`, or at the backstop
   * ceiling. `checkpoint` runs on every poll; whatever it throws ends the wait with that error.
   */
  waitHealthy(checkpoint?: () => void): Promise<void>;
  /** Never throws; the caller reports a failed teardown. */
  teardown(): Promise<StopResult>;
}

/**
 * All or nothing: on a throw it has already removed what it started, so a caller never tracks a
 * service container it got no handle to. `checkpoint` runs before each container, never during one:
 * a `docker run` abandoned mid-create can leave a container behind that nobody removes.
 */
export async function startServices(
  id: string,
  network: string,
  services: readonly ServiceSpec[],
  checkpoint: () => void = () => {},
): Promise<ServiceRuntime> {
  const started: string[] = [];
  try {
    for (const service of services) {
      checkpoint();
      started.push(await startServiceContainer(id, network, service));
    }
  } catch (error) {
    await Promise.all(started.map((name) => removeContainerByName(name)));
    throw error;
  }

  return {
    names: started,
    async waitHealthy(checkpoint: () => void = () => {}): Promise<void> {
      const gated = services.filter((service) => service.healthcheck !== undefined && service.healthcheck.test[0] !== "NONE");
      const pending = new Set(gated.map((service) => service.name));
      const deadline = Date.now() + HEALTH_WAIT_CEILING_MS;
      while (pending.size > 0) {
        checkpoint();
        for (const service of gated) {
          if (!pending.has(service.name)) continue;
          const container = serviceContainerName(id, service.name);
          const state = await inspectService(container);
          if (state.kind === "exited") {
            throw new Error(await exitedMessage(service.name, container, state.exitCode));
          } else if (state.kind === "gone") {
            throw new Error(`Service "${service.name}" was removed before it became healthy.`);
          } else if (state.kind === "running" && state.health === "healthy") {
            pending.delete(service.name);
          } else if (state.kind === "running" && state.health === "unhealthy") {
            throw new Error(`Service "${service.name}" never became healthy (its healthcheck reports "unhealthy").`);
          }
        }
        if (pending.size === 0) return;
        if (Date.now() > deadline) {
          throw new Error(
            `Service${pending.size > 1 ? "s" : ""} ${[...pending].join(", ")} never became healthy within ` +
              `${HEALTH_WAIT_CEILING_MS / 1000}s.`,
          );
        }
        await Bun.sleep(HEALTH_POLL_INTERVAL_MS);
      }
    },
    async teardown(): Promise<StopResult> {
      const results = await Promise.all(started.map((name) => removeContainerByName(name)));
      const failed = results.filter((result) => !result.ok);
      if (failed.length === 0) return { ok: true, stderr: "" };
      return { ok: false, stderr: failed.map((result) => result.stderr).filter(Boolean).join("; ") };
    },
  };
}
