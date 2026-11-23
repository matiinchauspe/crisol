import { mkdirSync } from "node:fs";
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
