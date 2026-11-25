import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { installPackagesStep, type MountSpec } from "./docker";

export type TenazaAsset = { name: string; sha256: string };

/** Arch keys are what `uname -m` prints inside the Sandbox, not the asset names' arch. */
export interface TenazaRelease {
  version: string;
  assets: Record<"musl" | "glibc", Record<"aarch64" | "x86_64", TenazaAsset>>;
}

export const TENAZA_RELEASE: TenazaRelease = {
  version: "0.5.2",
  assets: {
    musl: {
      aarch64: {
        name: "tenaza-linux-arm64-musl",
        sha256: "a61fff23e27af6434275e2fa2e2bfd8994c128901a9201f3453584eb788bfcac",
      },
      x86_64: {
        name: "tenaza-linux-x64-musl",
        sha256: "7989c7cc44109115ea07e0d60b3e2ceab6896a586935364ecc161cb3449cfc49",
      },
    },
    glibc: {
      aarch64: {
        name: "tenaza-linux-arm64",
        sha256: "0fc38bac013cea13844c63dc9a3f3b3e39dd90c4d2ce77f56e64bd1710c5e1f6",
      },
      x86_64: {
        name: "tenaza-linux-x64",
        sha256: "a3583da49fb13ec4717da98c5d37808a43e7a04e71bc62be4f96099f62001d7c",
      },
    },
  },
};

/** Where Tenaza itself looks on the host, so Crisol and Tenaza never disagree about it. */
export function hostTenazaHome(): string {
  return process.env.TENAZA_HOME ?? path.join(homedir(), ".tenaza");
}

/**
 * Config and state are read-only: the agent can neither edit `policy.toml` to authorize itself,
 * answer held actions in host sessions, nor rewrite what `tenaza run` executes. `relay-requested`
 * is the hook's only way to make the host daemon notify. Each dir is created up front because
 * `--mount` refuses a missing source.
 */
export function tenazaMounts(hostHome: string, containerHome: string): MountSpec[] {
  const config = path.join(hostHome, "config");
  const state = path.join(hostHome, "state");
  const relayRequested = path.join(state, "relay-requested");
  mkdirSync(config, { recursive: true });
  mkdirSync(path.join(state, "sessions"), { recursive: true });
  mkdirSync(relayRequested, { recursive: true });
  return [
    { hostPath: config, containerPath: `${containerHome}/config`, mode: "ro" },
    { hostPath: state, containerPath: `${containerHome}/state`, mode: "ro" },
    { hostPath: relayRequested, containerPath: `${containerHome}/state/relay-requested`, mode: "rw" },
  ];
}

export function tenazaSessionsDir(containerHome: string): string {
  return `${containerHome}/state/sessions`;
}

export interface TenazaRelayPaths {
  sinkDir: string;
  hostHome: string;
  /** The sessions this Run started, one id per line, so a Continuation keeps relaying them. */
  recordPath: string;
  /** The Clone: the only cwd a relayed session may start in. */
  repoPath: string;
}

export interface RelayRefusal {
  session: string;
  reason: string;
}

const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const MAX_SINK_BYTES = 16 * 1024 * 1024;
const HOOK_EVENTS = new Set([
  "session.started",
  "session.labeled",
  "action.decided",
  "usage.sampled",
  "session.ended",
  "prompt.submitted",
  "notification.observed",
  "turn.ended",
]);

function vetLine(line: string, session: string, owned: Set<string>, repoPath: string): string | { refused: string } {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { refused: "is not JSON" };
  }
  if (typeof event !== "object" || event === null || Array.isArray(event)) return { refused: "is not an event" };
  const record = event as Record<string, unknown>;
  if (record.session !== session) return { refused: `names session ${JSON.stringify(record.session)}` };
  if (typeof record.type !== "string" || !HOOK_EVENTS.has(record.type)) {
    return { refused: `is a ${JSON.stringify(record.type)} event, which only the host writes` };
  }
  const data = typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : undefined;
  if (record.type === "session.started") {
    const cwd = data?.cwd;
    const relative = typeof cwd === "string" ? path.relative(repoPath, cwd) : "..";
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { refused: `starts the session outside the Clone, in ${String(cwd)}` };
    }
  }
  if (data && "parent" in data && !(typeof data.parent === "string" && owned.has(data.parent))) {
    return { refused: `claims parent ${JSON.stringify(data.parent)}, a session this Run did not start` };
  }
  if (data) {
    // They name the Sandbox's terminal and process, which mean nothing on the host.
    delete data.terminal;
    delete data.pid;
    delete data.pidStartedAt;
  }
  // Tenaza identifies a row by (session, line number), so rewriting its content keeps its identity.
  return JSON.stringify(record);
}

/**
 * One line for one line, so the line numbers Inbox ids hash stay the Sandbox's own; the host file's
 * line count is what was already relayed. A refused line stops its session's relay for good.
 */
export function relayTenazaSessions(paths: TenazaRelayPaths): RelayRefusal[] {
  const hostSessions = path.join(paths.hostHome, "state", "sessions");
  const refusals: RelayRefusal[] = [];
  const sinkSessions = readdirSync(paths.sinkDir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => file.slice(0, -".jsonl".length))
    .filter((session) => SESSION_ID.test(session));
  const owned = new Set(existsSync(paths.recordPath) ? readFileSync(paths.recordPath, "utf8").split("\n").filter(Boolean) : []);
  const blocked = new Set<string>();

  for (const session of sinkSessions) {
    if (owned.has(session)) continue;
    if (existsSync(path.join(hostSessions, `${session}.jsonl`))) {
      refusals.push({ session, reason: "the host already holds a session by that id" });
      blocked.add(session);
      continue;
    }
    appendFileSync(paths.recordPath, `${session}\n`);
    owned.add(session);
  }

  for (const session of sinkSessions) {
    if (blocked.has(session)) continue;
    const sinkFile = path.join(paths.sinkDir, `${session}.jsonl`);
    if (statSync(sinkFile).size > MAX_SINK_BYTES) {
      refusals.push({ session, reason: `is over ${MAX_SINK_BYTES} bytes` });
      continue;
    }
    const content = readFileSync(sinkFile, "utf8");
    const whole = content.slice(0, content.lastIndexOf("\n") + 1);
    if (!whole) continue;
    const hostFile = path.join(hostSessions, `${session}.jsonl`);
    const relayed = existsSync(hostFile) ? readFileSync(hostFile, "utf8").split("\n").length - 1 : 0;
    const sinkLines = whole.slice(0, -1).split("\n");
    let nonBlank = sinkLines.slice(0, relayed).filter((line) => line.trim()).length;
    let out = "";
    for (const line of sinkLines.slice(relayed)) {
      if (!line.trim()) {
        out += `${line}\n`;
        continue;
      }
      nonBlank += 1;
      const vetted = vetLine(line, session, owned, paths.repoPath);
      if (typeof vetted !== "string") {
        refusals.push({ session, reason: `line ${nonBlank} ${vetted.refused}` });
        break;
      }
      out += `${vetted}\n`;
    }
    if (out) appendFileSync(hostFile, out);
  }
  return refusals;
}

export const TENAZA_RELAY_INTERVAL_MS = 250;

export function startTenazaRelay(
  options: TenazaRelayPaths & { intervalMs?: number; onRefused: (refusal: RelayRefusal) => void },
): { stop(): void } {
  const reported = new Set<string>();
  const pass = () => {
    let refusals: RelayRefusal[];
    try {
      refusals = relayTenazaSessions(options);
    } catch (error) {
      refusals = [{ session: "*", reason: error instanceof Error ? error.message : String(error) }];
    }
    for (const refusal of refusals) {
      if (reported.has(refusal.session)) continue;
      reported.add(refusal.session);
      options.onRefused(refusal);
    }
  };
  const timer = setInterval(pass, options.intervalMs ?? TENAZA_RELAY_INTERVAL_MS);
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      pass();
    },
  };
}

/**
 * Picks the asset at build time, so one Dockerfile serves either libc and arch; only musl ships a
 * `/lib/ld-musl-<arch>.so.1` loader. `TENAZA_HOME` lets the binary find the mounts as any user.
 */
export function tenazaLayerSteps(release: TenazaRelease, containerHome: string): string[] {
  const url = `https://github.com/matiinchauspe/tenaza/releases/download/v${release.version}`;
  const cases = (["musl", "glibc"] as const).flatMap((libc) =>
    (["aarch64", "x86_64"] as const).map((arch) => {
      const { name, sha256 } = release.assets[libc][arch];
      return `${libc}-${arch}) asset=${name}; sum=${sha256};;`;
    }),
  );
  return [
    // Bun's musl build links both dynamically; without them it fails to load.
    installPackagesStep({ apk: ["libgcc", "libstdc++"], apt: [] }),
    [
      'RUN if [ -e "/lib/ld-musl-$(uname -m).so.1" ]; then libc=musl; else libc=glibc; fi',
      '&& case "$libc-$(uname -m)" in',
      ...cases,
      `*) echo "No Tenaza ${release.version} build for $libc on $(uname -m)" >&2; exit 1;;`,
      "esac",
      `&& curl -fsSL -o /usr/local/bin/tenaza "${url}/$asset"`,
      '&& echo "$sum  /usr/local/bin/tenaza" | sha256sum -c -',
      "&& chmod 0755 /usr/local/bin/tenaza",
    ].join(" "),
    `ENV TENAZA_HOME=${containerHome}`,
  ];
}
