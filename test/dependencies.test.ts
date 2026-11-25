import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PACKAGE_CACHE_MOUNT, buildInstallArgs, detectPackageManager } from "../src/dependencies";
import { runDocker } from "../src/docker";

function withLockfile(name: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "crisol-lockfile-"));
  try {
    if (name.length > 0) writeFileSync(path.join(dir, name), "");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("detectPackageManager", () => {
  test("bun.lock selects bun", () => {
    withLockfile("bun.lock", (dir) => expect(detectPackageManager(dir)).toBe("bun"));
  });

  test("bun.lockb, Bun's binary lockfile before 1.2, selects bun", () => {
    withLockfile("bun.lockb", (dir) => expect(detectPackageManager(dir)).toBe("bun"));
  });

  test("a Yarn 2+ repo selects yarn", () => {
    withLockfile("yarn.lock", (dir) => {
      writeFileSync(path.join(dir, ".yarnrc.yml"), "nodeLinker: node-modules\n");
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ packageManager: "yarn@4.5.3" }));
      expect(detectPackageManager(dir)).toBe("yarn");
    });
  });

  test("pnpm-lock.yaml selects pnpm", () => {
    withLockfile("pnpm-lock.yaml", (dir) => expect(detectPackageManager(dir)).toBe("pnpm"));
  });

  test("package-lock.json selects npm", () => {
    withLockfile("package-lock.json", (dir) => expect(detectPackageManager(dir)).toBe("npm"));
  });

  test("yarn.lock selects yarn", () => {
    withLockfile("yarn.lock", (dir) => expect(detectPackageManager(dir)).toBe("yarn"));
  });

  test("no lockfile selects nothing — no install is attempted", () => {
    withLockfile("", (dir) => expect(detectPackageManager(dir)).toBeUndefined());
  });

  test("a mixed repo picks deterministically — bun.lock first, per the spec's own order", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crisol-lockfile-"));
    try {
      writeFileSync(path.join(dir, "yarn.lock"), "");
      writeFileSync(path.join(dir, "bun.lock"), "");
      expect(detectPackageManager(dir)).toBe("bun");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildInstallArgs", () => {
  test("bun installs from the lockfile and caches under the shared volume's bun subdirectory", () => {
    expect(buildInstallArgs("bun")).toEqual(["bun", "install", "--cache-dir", `${PACKAGE_CACHE_MOUNT}/bun`]);
  });

  test("pnpm installs from the lockfile and stores under the shared volume's pnpm subdirectory", () => {
    expect(buildInstallArgs("pnpm")).toEqual(["pnpm", "install", "--store-dir", `${PACKAGE_CACHE_MOUNT}/pnpm`]);
  });

  test("npm uses `ci`, which fails on a lockfile/manifest mismatch rather than silently updating either", () => {
    expect(buildInstallArgs("npm")).toEqual(["npm", "ci", "--cache", `${PACKAGE_CACHE_MOUNT}/npm`]);
  });

  test("yarn passes its cache through the environment, since Yarn 2+ rejects Yarn 1's --cache-folder flag", () => {
    expect(buildInstallArgs("yarn")).toEqual([
      "env",
      `YARN_CACHE_FOLDER=${PACKAGE_CACHE_MOUNT}/yarn`,
      `YARN_GLOBAL_FOLDER=${PACKAGE_CACHE_MOUNT}/yarn/berry`,
      "yarn",
      "install",
    ]);
  });
});

// Crisol's default image carries no Yarn; this one has Yarn 1.22.22 and Corepack for Yarn 2+ (read live).
const NODE_IMAGE = "node:22-bookworm-slim";

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function installYarnRepoInNodeImage(packageManagerField: string | undefined): Promise<string> {
  const manifest = {
    name: "fixture",
    version: "0.0.0",
    license: "MIT",
    ...(packageManagerField === undefined ? {} : { packageManager: packageManagerField }),
    dependencies: { "is-number": "7.0.0" },
  };
  const script = [
    "set -e",
    "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
    "corepack enable",
    "mkdir /w && cd /w",
    `echo ${shellQuote(JSON.stringify(manifest))} > package.json`,
    packageManagerField === undefined ? "true" : "echo 'nodeLinker: node-modules' > .yarnrc.yml",
    `${buildInstallArgs("yarn").map(shellQuote).join(" ")} >&2`,
    "test -d node_modules/is-number",
    `find ${PACKAGE_CACHE_MOUNT} -type f`,
  ].join("\n");
  const result = await runDocker(["docker", "run", "--rm", NODE_IMAGE, "sh", "-c", script]);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout;
}

describe("yarn's install lands its cache under the shared volume", () => {
  test(
    "Yarn 1 installs and caches there",
    async () => {
      expect(await installYarnRepoInNodeImage(undefined)).toContain(`${PACKAGE_CACHE_MOUNT}/yarn/v6/`);
    },
    180_000,
  );

  test(
    "a Yarn 2+ repo installs and caches there",
    async () => {
      expect(await installYarnRepoInNodeImage("yarn@4.5.3")).toMatch(
        new RegExp(`${PACKAGE_CACHE_MOUNT}/yarn/berry/cache/is-number-npm-7\\.0\\.0-.*\\.zip`),
      );
    },
    180_000,
  );
});
