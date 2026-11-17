import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/run";
import { FakeAdapter } from "../src/adapters/fake";
import { ensureDefaultProjectImage, startSandbox } from "../src/docker";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { runCli } from "./support/cli";

/**
 * Containment tests must prove reality, not trust Crisol's own bookkeeping.
 * (a) from INSIDE the Sandbox, the host fixture repo's own path must not exist.
 * (b) a before/after snapshot of the host's refs must show the ONLY difference is
 *     the added branch.
 */
describe("Sandbox containment proven from the inside (W7a)", () => {
  test("the host repo's own absolute path is not visible inside the Sandbox", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const probeScript = [
        `test ! -e '${repo.path}' && echo CLEAN > containment.txt || echo LEAK > containment.txt`,
        "git add containment.txt",
        "git commit --quiet -m 'test: containment probe'",
      ];

      const result = await run({
        task: "containment probe",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter(probeScript),
      });

      const probeFile = Bun.spawnSync(
        ["git", "-C", repo.path, "show", `${result.branch}:containment.txt`],
        { stdout: "pipe" },
      )
        .stdout.toString("utf8")
        .trim();
      expect(probeFile).toBe("CLEAN");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("Host ref snapshot before/after a Run (W7b)", () => {
  test("the only host ref change from a Run is the added branch", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const before = Bun.spawnSync(["git", "-C", repo.path, "for-each-ref"], { stdout: "pipe" })
        .stdout.toString("utf8")
        .trim()
        .split("\n")
        .sort();

      const result = await runCli(["run", "say hello", "--json"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);

      const after = Bun.spawnSync(["git", "-C", repo.path, "for-each-ref"], { stdout: "pipe" })
        .stdout.toString("utf8")
        .trim()
        .split("\n")
        .sort();

      const added = after.filter((line) => !before.includes(line));
      const removed = before.filter((line) => !after.includes(line));
      expect(removed).toHaveLength(0);
      expect(added).toHaveLength(1);
      expect(added[0]).toContain(`refs/heads/${payload.branch}`);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

/**
 * The containment probes above are VACUOUS against a real leak — adding, say,
 * `-v $HOME:$HOME` to `docker run` would still pass both of them, since neither checks
 * the actual mount SET. This asserts the exact mount set docker itself reports, compared
 * to exactly what was declared.
 */
describe("Sandbox mounts are exactly what was declared, nothing extra (finding 3)", () => {
  test("docker inspect's own Mounts contain exactly the Clone's bind mount, no more", async () => {
    const image = await ensureDefaultProjectImage();
    const id = `mounts-exact-${Date.now()}`;
    const mountPath = mkdtempSync(path.join(tmpdir(), "crisol-mount-probe-"));
    const sandbox = await startSandbox({ image, mountPath, env: {}, id });
    try {
      const inspect = Bun.spawnSync(
        ["docker", "inspect", "--format", "{{json .Mounts}}", sandbox.containerId],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(inspect.exitCode).toBe(0);
      const mounts = JSON.parse(inspect.stdout.toString("utf8")) as Array<{
        Source: string;
        Destination: string;
        RW: boolean;
      }>;
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.Source).toBe(mountPath);
      expect(mounts[0]!.Destination).toBe(mountPath);
      expect(mounts[0]!.RW).toBe(true);
    } finally {
      await sandbox.stop();
      rmSync(mountPath, { recursive: true, force: true });
    }
  }, 30_000);
});
