import { existsSync } from "node:fs";
import path from "node:path";
import { execAsRoot } from "./docker";
import type { Sandbox } from "./docker";

export type PackageManager = "bun" | "pnpm" | "npm" | "yarn";

interface LockfileRule {
  file: string;
  manager: PackageManager;
}

/** First match wins; a repo should carry exactly one lockfile, but a mixed one still picks deterministically. */
const LOCKFILE_RULES: readonly LockfileRule[] = [
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "package-lock.json", manager: "npm" },
  { file: "yarn.lock", manager: "yarn" },
];

/** Reads the Clone, not the host working tree: the lockfile that matters is the one at `baseSha`. */
export function detectPackageManager(cloneDir: string): PackageManager | undefined {
  for (const rule of LOCKFILE_RULES) {
    if (existsSync(path.join(cloneDir, rule.file))) return rule.manager;
  }
  return undefined;
}

/** One volume for every Run, every repo: never torn down, never named by run id. */
export const PACKAGE_CACHE_VOLUME = "crisol-pkg-cache";
export const PACKAGE_CACHE_MOUNT = "/crisol/pkg-cache";

function cacheDir(manager: PackageManager): string {
  return `${PACKAGE_CACHE_MOUNT}/${manager}`;
}

export function buildInstallArgs(manager: PackageManager): string[] {
  switch (manager) {
    case "bun":
      return ["bun", "install", "--cache-dir", cacheDir(manager)];
    case "pnpm":
      return ["pnpm", "install", "--store-dir", cacheDir(manager)];
    case "npm":
      return ["npm", "ci", "--cache", cacheDir(manager)];
    case "yarn":
      // Yarn 2+ rejects Yarn 1's `--cache-folder`, but both read `YARN_CACHE_FOLDER`; Yarn 4 caches
      // in its global folder by default and ignores the cache folder there, so that moves too.
      return [
        "env",
        `YARN_CACHE_FOLDER=${cacheDir(manager)}`,
        `YARN_GLOBAL_FOLDER=${cacheDir(manager)}/berry`,
        "yarn",
        "install",
      ];
  }
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Installs into the Clone's own `node_modules` (Linux binaries, never shared between Runs: it is
 * the Clone's own bind mount) with the package manager's cache under the shared volume. The
 * volume is long-lived across Runs and may already be owned by a different Run's container user
 * (root or the Agent layer's non-root `agent`); `execAsRoot` fixes that before every install,
 * whatever user this Sandbox itself runs as — verified live against both.
 */
export async function installDependencies(sandbox: Sandbox, manager: PackageManager): Promise<void> {
  const prep = await execAsRoot(sandbox.containerId, [
    "sh",
    "-c",
    `mkdir -p ${shellQuote(cacheDir(manager))} && chmod -R 0777 ${shellQuote(PACKAGE_CACHE_MOUNT)}`,
  ]);
  if (prep.exitCode !== 0) {
    throw new Error(`Could not prepare the package-manager cache for ${manager}: ${(prep.stderr || prep.stdout).trim()}`);
  }
  const install = await sandbox.exec(buildInstallArgs(manager));
  if (install.exitCode !== 0) {
    throw new Error(`"${manager} install" failed: ${(install.stderr || install.stdout).trim()}`);
  }
}
