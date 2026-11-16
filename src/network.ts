import { mkdirSync, writeFileSync } from "node:fs";
import { ensureImageFromDockerfile } from "./docker";
import type { ExecResult, StopResult } from "./docker";
import { runNetworkDir, runProxyConfPath, runProxyFilterPath } from "./paths";

export type NetworkMode = "allowlist" | "learn" | "open";

export type WallPolicy = { mode: "allowlist"; hosts: readonly string[] } | { mode: "learn" };

export interface Blocked {
  host: string;
  /** Set only when the port is not the scheme's own (443 for CONNECT, 80 for plain HTTP). */
  port?: number;
  count: number;
}

/** Exact hostnames, never a wildcarded domain — least privilege, the same boundary Credentials draws. */
export const BUILT_IN_ALLOWLIST: readonly string[] = [
  "api.anthropic.com",
  "registry.npmjs.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "pypi.org",
  "files.pythonhosted.org",
];

const PROXY_PORT = 8888;
const CONNECT_PORT = 443;
const HTTP_PORT = 80;
/**
 * tinyproxy's `-d` keeps it in the foreground, or `docker logs` — where `readTraffic` reads
 * refusals and connections — sees nothing. Without `CMD` the container runs Alpine's `/bin/sh`
 * and exits at once.
 */
const PROXY_DOCKERFILE =
  'FROM alpine:3.20\nRUN apk add --no-cache tinyproxy\nCMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]\n';
const PROXY_IMAGE_TAG = "crisol-proxy:0.1.0";

export async function ensureProxyImage(): Promise<string> {
  return ensureImageFromDockerfile(PROXY_IMAGE_TAG, PROXY_DOCKERFILE);
}

const PLAIN_HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Letters, digits and hyphens only, with a top-level label that starts with a letter — so no
 * shell metacharacter, and no IP literal, can reach a command the user is told to paste.
 */
export function isPlainHostname(host: string): boolean {
  return PLAIN_HOSTNAME.test(host);
}

/**
 * Names that resolve to the machine, its containers, the LAN or a cloud metadata service, never to
 * the public internet — opening one would let every Run reach inside. Each entry is a top-level
 * label: `internal` (ICANN's private-use TLD, holding `host.docker.internal` and
 * `metadata.google.internal`), `local` (mDNS, and Kubernetes' `cluster.local`), `localhost`
 * (loopback, RFC 6761), `localdomain` (the `/etc/hosts` loopback alias), `svc` (Kubernetes
 * services), `arpa` (reverse DNS and `home.arpa`), and `lan`, `home`, `corp` (never delegated,
 * used by routers and company DNS).
 */
const INTERNAL_TOP_LEVEL_LABELS = ["internal", "local", "localhost", "localdomain", "svc", "arpa", "lan", "home", "corp"];

export function isInternalHostname(host: string): boolean {
  const labels = host.toLowerCase().split(".");
  return labels[0] === "localhost" || INTERNAL_TOP_LEVEL_LABELS.includes(labels[labels.length - 1]!);
}

function escapeForExtendedRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * With `FilterURLs On` tinyproxy matches a CONNECT as `host:port` and a plain HTTP request as its
 * whole URL, so each pattern pins the port too: `ConnectPort` never reaches plain HTTP, and
 * matching the host alone let `http://github.com:22/` through to any port of an allowlisted host.
 * The trailing `/` keeps `http://host:80@other/` from passing as `host`.
 */
export function renderTinyproxyFilter(hosts: readonly string[]): string {
  return (
    hosts
      .flatMap((host) => {
        const escaped = escapeForExtendedRegex(host);
        return [`^${escaped}:${CONNECT_PORT}$`, `^http://${escaped}(:${HTTP_PORT})?/`];
      })
      .join("\n") + "\n"
  );
}

/**
 * `Allow` is the internal subnet, never `0.0.0.0/0`: the proxy's other leg is on the default
 * bridge, and any container there could otherwise relay through it. No `ConnectPort`: the filter
 * already pins every port, and a `ConnectPort` refusal logs the port without the host.
 */
export function renderTinyproxyConf(allowedClientCidr: string, mode: WallPolicy["mode"] = "allowlist"): string {
  const filter =
    mode === "learn"
      ? []
      : ['Filter "/etc/tinyproxy/filter"', "FilterType ere", "FilterURLs On", "FilterDefaultDeny Yes"];
  return (
    [
      "User nobody",
      "Group nobody",
      `Port ${PROXY_PORT}`,
      "Listen 0.0.0.0",
      "Timeout 600",
      'DefaultErrorFile "/usr/share/tinyproxy/default.html"',
      'StatFile "/usr/share/tinyproxy/stats.html"',
      "LogLevel Info",
      "MaxClients 100",
      `Allow ${allowedClientCidr}`,
      ...filter,
    ].join("\n") + "\n"
  );
}

const BLOCKED_LOG_LINE = /Proxying refused on filtered url "([^"]+)"/g;

/**
 * tinyproxy names a CONNECT as `host:port` and a plain HTTP request as its whole URL. `URL` reads
 * the host the way tinyproxy routes it, past any `user@`; the `tcp:` scheme has no default
 * port, so a CONNECT's port is never dropped.
 */
function parseTarget(target: string): { host: string; port?: number } | undefined {
  const isHttp = /^http:\/\//i.test(target);
  let url: URL;
  try {
    url = new URL(isHttp ? target : `tcp://${target}`);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host.length === 0) return undefined;
  const ownPort = isHttp ? HTTP_PORT : CONNECT_PORT;
  const port = url.port === "" ? ownPort : Number(url.port);
  return port === ownPort ? { host } : { host, port };
}

function countTargets(rawTargets: Iterable<string>, keep: (host: string) => boolean = () => true): Blocked[] {
  const counts = new Map<string, Blocked>();
  for (const raw of rawTargets) {
    const target = parseTarget(raw);
    if (target === undefined || !keep(target.host)) continue;
    const key = `${target.host}:${target.port ?? ""}`;
    const entry = counts.get(key) ?? { ...target, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()];
}

export function parseBlockedHosts(log: string): Blocked[] {
  return countTargets([...log.matchAll(BLOCKED_LOG_LINE)].map((match) => match[1]!));
}

/**
 * Anchored to tinyproxy's own line prefix, timestamp included, so text the agent put mid-line in a
 * request is not read as a connection. A bare `\r` still splits a line under the `m` flag and can
 * forge one; that only adds a host to the lines printed for the user, on a Run that could reach any
 * host anyway.
 */
const LOG_PREFIX = String.raw`^CONNECT +[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}\.\d{3} \[\d+\]: `;
const REQUEST_LINE = new RegExp(
  `${LOG_PREFIX}Request \\(file descriptor \\d+\\): (?:CONNECT (\\S+)|[A-Z]+ (http://\\S+)) HTTP/\\d\\.\\d$`,
  "gm",
);
const ESTABLISHED_LINE = new RegExp(
  `${LOG_PREFIX}Established connection to host "([^"]+)" using file descriptor \\d+\\.$`,
  "gm",
);

/**
 * Every request whose host the proxy connected to at least once. tinyproxy logs the connection
 * without its port, so a port that failed counts as reached when the same host connected on
 * another; harmless, since a port is never offered to the Allowlist.
 */
export function parseReachedHosts(log: string): Blocked[] {
  const connected = new Set([...log.matchAll(ESTABLISHED_LINE)].map((match) => match[1]!.toLowerCase()));
  const requests = [...log.matchAll(REQUEST_LINE)].map((match) => (match[1] ?? match[2])!);
  return countTargets(requests, (host) => connected.has(host));
}

/** curl reads only lowercase `http_proxy` (httpoxy); npm, pip and git read the uppercase names. */
export function buildProxyEnv(proxyHost: string): Record<string, string> {
  const proxyUrl = `http://${proxyHost}:${PROXY_PORT}`;
  const noProxy = "localhost,127.0.0.1";
  return {
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

function spawnFailure(error: unknown): ExecResult {
  return { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
}

/**
 * Detached into its own session so a signal aimed at Crisol cannot kill a `docker network` call
 * half way. Never throws: a missing `docker` binary comes back as a failed result, so a teardown
 * after a failure reports instead of replacing the original error.
 */
function runDockerSync(args: string[]): ExecResult {
  try {
    const proc = Bun.spawnSync(args, { env: process.env, stdout: "pipe", stderr: "pipe", detached: true });
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString("utf8"), stderr: proc.stderr.toString("utf8") };
  } catch (error) {
    return spawnFailure(error);
  }
}

async function runDocker(args: string[]): Promise<ExecResult> {
  try {
    const proc = Bun.spawn(args, { env: process.env, stdout: "pipe", stderr: "pipe", detached: true });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    return spawnFailure(error);
  }
}

function networkName(id: string): string {
  return `crisol-net-${id}`;
}

function proxyContainerName(id: string): string {
  return `crisol-proxy-${id}`;
}

async function createInternalNetwork(id: string): Promise<string> {
  const name = networkName(id);
  const result = await runDocker(["docker", "network", "create", "--internal", "--label", `crisol.run=${id}`, name]);
  if (result.exitCode !== 0) {
    throw new Error(`docker network create failed for ${name}: ${result.stderr.trim()}`);
  }
  return name;
}

function inspectSubnet(name: string): string | undefined {
  const result = runDockerSync(["docker", "network", "inspect", name, "--format", "{{(index .IPAM.Config 0).Subnet}}"]);
  if (result.exitCode !== 0) return undefined;
  const subnet = result.stdout.trim();
  return subnet.length > 0 ? subnet : undefined;
}

async function removeNetwork(name: string): Promise<StopResult> {
  const result = await runDocker(["docker", "network", "rm", name]);
  if (result.exitCode === 0 || /not found/i.test(result.stderr)) {
    return { ok: true, stderr: "" };
  }
  return { ok: false, stderr: result.stderr.trim() };
}

/** By name, not by the shared label: a label sweep would also take the Sandbox, whose removal is reported apart. */
async function removeContainerByName(name: string): Promise<StopResult> {
  const result = await runDocker(["docker", "rm", "-f", name]);
  if (result.exitCode === 0 || /no such container/i.test(result.stderr)) {
    return { ok: true, stderr: "" };
  }
  return { ok: false, stderr: result.stderr.trim() };
}

interface StartProxyOptions {
  image: string;
  id: string;
  confPath: string;
  filterPath?: string;
}

/**
 * Starts on the default bridge — its own way out — and only then joins the internal network, where
 * the Sandbox resolves it by name. The Allowlist is bind-mounted, so one cached image serves every
 * Run whatever it allows.
 */
async function startProxyContainer(options: StartProxyOptions): Promise<string> {
  const { image, id, confPath, filterPath } = options;
  const name = proxyContainerName(id);
  const args = [
    "docker",
    "run",
    "-d",
    "--rm",
    "--init",
    "--pull",
    "never",
    "--name",
    name,
    "--label",
    `crisol.run=${id}`,
    "--mount",
    `type=bind,source=${confPath},target=/etc/tinyproxy/tinyproxy.conf,readonly`,
    ...(filterPath !== undefined
      ? ["--mount", `type=bind,source=${filterPath},target=/etc/tinyproxy/filter,readonly`]
      : []),
    image,
  ];
  const result = await runDocker(args);
  if (result.exitCode !== 0) {
    throw new Error(`docker run failed for the Allowlist proxy: ${result.stderr.trim()}`);
  }
  return name;
}

async function connectToNetwork(network: string, container: string): Promise<void> {
  const result = await runDocker(["docker", "network", "connect", network, container]);
  if (result.exitCode !== 0) {
    throw new Error(`docker network connect failed (${network} <- ${container}): ${result.stderr.trim()}`);
  }
}

export interface NetworkWall {
  networkName: string;
  /** Not a secret, so it rides the Sandbox's plain `env`. */
  proxyEnv: Record<string, string>;
  /** Call before `teardown`: refusals and connections live only in the proxy container's log. */
  readTraffic(): Promise<{ blocked: Blocked[]; reached: Blocked[] }>;
  /** Never throws and never logs; the caller reports a failed teardown. */
  teardown(): Promise<StopResult>;
}

/**
 * All or nothing: on a throw it has already removed what it created, so a caller never tracks a
 * network or proxy it got no handle to. An unreadable subnet throws rather than widen `Allow`;
 * `inspectSubnetFn` exists because a real `docker network inspect` cannot be made to fail on demand.
 */
export async function startNetworkWall(
  id: string,
  home: string,
  proxyImage: string,
  policy: WallPolicy,
  inspectSubnetFn: (name: string) => string | undefined = inspectSubnet,
): Promise<NetworkWall> {
  const network = await createInternalNetwork(id);
  try {
    const subnet = inspectSubnetFn(network);
    if (subnet === undefined) {
      throw new Error(
        `Could not read ${network}'s own subnet; refusing to start the Allowlist proxy with an unscoped \`Allow\`.`,
      );
    }
    const dir = runNetworkDir(id, home);
    mkdirSync(dir, { recursive: true });
    const confPath = runProxyConfPath(id, home);
    writeFileSync(confPath, renderTinyproxyConf(subnet, policy.mode));
    let filterPath: string | undefined;
    if (policy.mode === "allowlist") {
      filterPath = runProxyFilterPath(id, home);
      writeFileSync(filterPath, renderTinyproxyFilter(policy.hosts));
    }

    const container = await startProxyContainer({ image: proxyImage, id, confPath, filterPath });
    try {
      await connectToNetwork(network, container);
    } catch (error) {
      await removeContainerByName(container);
      throw error;
    }

    return {
      networkName: network,
      proxyEnv: buildProxyEnv(container),
      async readTraffic() {
        const logs = await runDocker(["docker", "logs", container]);
        const log = `${logs.stdout}\n${logs.stderr}`;
        return { blocked: parseBlockedHosts(log), reached: parseReachedHosts(log) };
      },
      async teardown(): Promise<StopResult> {
        const containerRemoved = await removeContainerByName(container);
        const networkRemoved = await removeNetwork(network);
        if (containerRemoved.ok && networkRemoved.ok) return { ok: true, stderr: "" };
        return {
          ok: false,
          stderr: [containerRemoved.stderr, networkRemoved.stderr].filter(Boolean).join("; "),
        };
      },
    };
  } catch (error) {
    await removeNetwork(network);
    throw error;
  }
}

/** `crisol recover`'s label sweep already removes the proxy container; a network is not a container. */
export async function removeNetworkByRunId(id: string): Promise<StopResult> {
  return removeNetwork(networkName(id));
}
