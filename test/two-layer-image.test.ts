import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FakeAdapter } from "../src/adapters/fake";
import { PACKAGE_CACHE_VOLUME } from "../src/dependencies";
import { ensureImageFromDockerfile, removeContainerByName, startSandbox } from "../src/docker";
import { runRepoPath } from "../src/paths";
import { run } from "../src/run";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

function sh(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`\`${args.join(" ")}\` failed in ${cwd}: ${proc.stderr.toString("utf8")}`);
  }
}

function gitShow(repoPath: string, branch: string, file: string): string {
  return Bun.spawnSync(["git", "-C", repoPath, "show", `${branch}:${file}`], { stdout: "pipe" }).stdout.toString("utf8");
}

const PROBE_SCRIPT = (check: string): readonly string[] => [
  `${check} > /dev/null 2>&1 && echo present=yes > TOOLCHAIN.txt || echo present=no > TOOLCHAIN.txt`,
  "git add TOOLCHAIN.txt",
  "git commit --quiet -m 'test: probe the Project layer toolchain'",
];

describe("Project layer selection (ticket 12)", () => {
  test("a repo with .crisol/Dockerfile runs on that toolchain", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      mkdirSync(path.join(repo.path, ".crisol"));
      // `jq` is not on Crisol's own default Project layer, so finding it proves the REPO's own
      // Dockerfile was built and used, not the default falling through silently.
      writeFileSync(path.join(repo.path, ".crisol", "Dockerfile"), "FROM alpine:3.20\nRUN apk add --no-cache git bash jq\n");
      sh(["git", "add", ".crisol/Dockerfile"], repo.path);
      sh(["git", "commit", "-q", "-m", "chore: declare a Project layer"], repo.path);

      const result = await run({
        task: "probe the toolchain",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter(PROBE_SCRIPT("command -v jq")),
      });

      expect(gitShow(repo.path, result.branch, "TOOLCHAIN.txt").trim()).toBe("present=yes");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a repo without .crisol/Dockerfile runs on Crisol's own default Project layer (git, Node, Bun, Python, gh, rg)", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({
        task: "probe the toolchain",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter(PROBE_SCRIPT("command -v node && command -v bun && command -v python3 && command -v gh && command -v rg")),
      });

      expect(gitShow(repo.path, result.branch, "TOOLCHAIN.txt").trim()).toBe("present=yes");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("Agent layer caching (ticket 12, acceptance 2)", () => {
  test("the same tag reuses the cached image without rebuilding; a new tag (what a changed input produces) rebuilds", async () => {
    const nonce = `${Date.now()}`;
    const tag = `crisol-cache-test-${nonce}`;
    const newTag = `${tag}-v2`;
    const id = `cache-test-${nonce}`;
    try {
      await ensureImageFromDockerfile(tag, "FROM alpine:3.20\nRUN echo first > /marker.txt\n");
      // Same tag, DIFFERENT content: `buildAgentLayerSpec`'s own hash is what changes the tag when
      // an input changes, so a cache keyed on tag alone must treat this as a no-op.
      const reused = await ensureImageFromDockerfile(tag, "FROM alpine:3.20\nRUN echo second > /marker.txt\n");
      expect(reused).toBe(tag);

      const sandbox = await startSandbox({ image: tag, mountPath: "/tmp", env: {}, id });
      const probe = await sandbox.exec(["cat", "/marker.txt"]);
      await sandbox.stop();
      expect(probe.stdout.trim()).toBe("first"); // the ORIGINAL content — proves no rebuild happened

      // A different tag, as a changed Project layer / agent version / Tenaza version would
      // produce, DOES rebuild — the new content takes effect.
      await ensureImageFromDockerfile(newTag, "FROM alpine:3.20\nRUN echo second > /marker.txt\n");
      const sandbox2 = await startSandbox({ image: newTag, mountPath: "/tmp", env: {}, id: `${id}-v2` });
      const probe2 = await sandbox2.exec(["cat", "/marker.txt"]);
      await sandbox2.stop();
      expect(probe2.stdout.trim()).toBe("second");
    } finally {
      await removeContainerByName(`crisol-${id}`);
      await removeContainerByName(`crisol-${id}-v2`);
      Bun.spawnSync(["docker", "rmi", tag, newTag]);
    }
  }, 30_000);
});

/** Whichever Linux platform package `bun install` resolved for this host's architecture. */
function findEsbuildBinary(cloneDir: string): string {
  const dir = path.join(cloneDir, "node_modules", "@esbuild");
  const platformDir = readdirSync(dir).find((name) => name.startsWith("linux-"));
  if (platformDir === undefined) {
    throw new Error(`No "linux-*" @esbuild platform package found under ${dir}: ${readdirSync(dir).join(", ")}`);
  }
  return path.join(dir, platformDir, "bin", "esbuild");
}

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

describe("Dependency install (ticket 12)", () => {
  test(
    "bun.lock selects bun; the install succeeds behind the wall, lands Linux binaries in the Clone, " +
      "never shares them between Runs, and reuses the shared cache volume",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        // esbuild carries a real platform-specific native binary — the standard proof that an
        // install happened INSIDE the Linux Sandbox, not on the macOS host.
        writeFileSync(
          path.join(repo.path, "package.json"),
          JSON.stringify({ name: "fixture", version: "0.0.0", dependencies: { esbuild: "0.21.5" } }),
        );
        // Crisol selects a package manager from the lockfile's PRESENCE, never its content.
        writeFileSync(path.join(repo.path, "bun.lock"), "");
        sh(["git", "add", "package.json", "bun.lock"], repo.path);
        sh(["git", "commit", "-q", "-m", "chore: add a bun-managed dependency"], repo.path);

        const result1 = await run({ task: "noop", cwd: repo.path, home: home.path });
        expect(result1.status).not.toBe("not-converged");
        expect(result1.blocked.find((b) => b.host === "registry.npmjs.org")).toBeUndefined();
        const clone1 = runRepoPath(result1.run, home.path);
        const binary1 = findEsbuildBinary(clone1);
        expect(existsSync(binary1)).toBe(true);
        expect(readFileSync(binary1).subarray(0, 4)).toEqual(ELF_MAGIC);

        const result2 = await run({ task: "noop", cwd: repo.path, home: home.path });
        expect(result2.run).not.toBe(result1.run);
        expect(result2.blocked.find((b) => b.host === "registry.npmjs.org")).toBeUndefined();
        const clone2 = runRepoPath(result2.run, home.path);
        expect(clone2).not.toBe(clone1);
        const binary2 = findEsbuildBinary(clone2);
        expect(existsSync(binary2)).toBe(true);

        // Never shared: each Run's node_modules is its OWN Clone's install, not a link into the
        // other's — both trees still stand, independently, after both Runs finished.
        expect(existsSync(path.join(clone1, "node_modules"))).toBe(true);
        expect(existsSync(path.join(clone2, "node_modules"))).toBe(true);

        // The cache volume: one fixed name across both Runs (never per-run), left non-empty.
        const probe = Bun.spawnSync(
          ["docker", "run", "--rm", "--mount", `type=volume,source=${PACKAGE_CACHE_VOLUME},target=/v`, "alpine:3.20", "find", "/v/bun", "-type", "f"],
          { stdout: "pipe", stderr: "pipe" },
        );
        expect(probe.exitCode).toBe(0);
        expect(probe.stdout.toString("utf8").trim().length).toBeGreaterThan(0);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    180_000,
  );

  test("a repo with no lockfile never attempts an install", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({ task: "say hello", cwd: repo.path, home: home.path });
      expect(result.status).not.toBe("not-converged");
      const clone = runRepoPath(result.run, home.path);
      expect(existsSync(path.join(clone, "node_modules"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});
