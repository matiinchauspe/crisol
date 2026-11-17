import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PACKAGE_CACHE_MOUNT, buildInstallArgs, detectPackageManager } from "../src/dependencies";

function withLockfile(name: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "crisol-lockfile-"));
  try {
    if (name.length > 0) writeFileSync(path.join(dir, name), "");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("detectPackageManager (ticket 12)", () => {
  test("bun.lock selects bun", () => {
    withLockfile("bun.lock", (dir) => expect(detectPackageManager(dir)).toBe("bun"));
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

describe("buildInstallArgs (ticket 12)", () => {
  test("bun installs from the lockfile and caches under the shared volume's bun subdirectory", () => {
    expect(buildInstallArgs("bun")).toEqual(["bun", "install", "--cache-dir", `${PACKAGE_CACHE_MOUNT}/bun`]);
  });

  test("pnpm installs from the lockfile and stores under the shared volume's pnpm subdirectory", () => {
    expect(buildInstallArgs("pnpm")).toEqual(["pnpm", "install", "--store-dir", `${PACKAGE_CACHE_MOUNT}/pnpm`]);
  });

  test("npm uses `ci`, which fails on a lockfile/manifest mismatch rather than silently updating either", () => {
    expect(buildInstallArgs("npm")).toEqual(["npm", "ci", "--cache", `${PACKAGE_CACHE_MOUNT}/npm`]);
  });

  test("yarn installs from the lockfile and caches under the shared volume's yarn subdirectory", () => {
    expect(buildInstallArgs("yarn")).toEqual(["yarn", "install", "--cache-folder", `${PACKAGE_CACHE_MOUNT}/yarn`]);
  });
});
