import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { MountSpec } from "./docker";

/** Assets keyed by what `uname -m` prints inside the Sandbox, not by the asset names' arch. */
export interface TenazaRelease {
  version: string;
  assets: Record<"aarch64" | "x86_64", { name: string; sha256: string }>;
}

/** musl builds, because every Sandbox is Alpine: Tenaza's glibc builds do not run there. */
export const TENAZA_RELEASE: TenazaRelease = {
  version: "0.5.2",
  assets: {
    aarch64: {
      name: "tenaza-linux-arm64-musl",
      sha256: "a61fff23e27af6434275e2fa2e2bfd8994c128901a9201f3453584eb788bfcac",
    },
    x86_64: {
      name: "tenaza-linux-x64-musl",
      sha256: "7989c7cc44109115ea07e0d60b3e2ceab6896a586935364ecc161cb3449cfc49",
    },
  },
};

/** Where Tenaza itself looks on the host, so Crisol and Tenaza never disagree about it. */
export function hostTenazaHome(): string {
  return process.env.TENAZA_HOME ?? path.join(homedir(), ".tenaza");
}

/**
 * Config is read-only so the agent cannot edit `policy.toml` to authorize itself. A missing dir is
 * created, not skipped: `--mount` refuses a source that does not exist, and skipping config would
 * leave no read-only mount at all.
 */
export function tenazaMounts(hostHome: string, containerHome: string): MountSpec[] {
  const config = path.join(hostHome, "config");
  const state = path.join(hostHome, "state");
  mkdirSync(config, { recursive: true });
  mkdirSync(state, { recursive: true });
  return [
    { hostPath: config, containerPath: `${containerHome}/config`, mode: "ro" },
    { hostPath: state, containerPath: `${containerHome}/state`, mode: "rw" },
  ];
}

/**
 * Picks the asset at build time, so one Dockerfile, and one cache key, serves either arch.
 * `TENAZA_HOME` is set so the binary finds the mounts whichever user runs it.
 */
export function tenazaLayerSteps(release: TenazaRelease, containerHome: string): string[] {
  const { aarch64, x86_64 } = release.assets;
  const url = `https://github.com/matiinchauspe/tenaza/releases/download/v${release.version}`;
  return [
    // Bun's musl build links both dynamically; without them it fails to load.
    "RUN apk add --no-cache libgcc libstdc++",
    [
      'RUN case "$(uname -m)" in',
      `aarch64) asset=${aarch64.name}; sum=${aarch64.sha256};;`,
      `x86_64) asset=${x86_64.name}; sum=${x86_64.sha256};;`,
      `*) echo "No Tenaza ${release.version} build for $(uname -m)" >&2; exit 1;;`,
      "esac",
      `&& curl -fsSL -o /usr/local/bin/tenaza "${url}/$asset"`,
      '&& echo "$sum  /usr/local/bin/tenaza" | sha256sum -c -',
      "&& chmod 0755 /usr/local/bin/tenaza",
    ].join(" "),
    `ENV TENAZA_HOME=${containerHome}`,
  ];
}
