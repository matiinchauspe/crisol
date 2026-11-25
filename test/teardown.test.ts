import { describe, expect, test } from "bun:test";
import { ensureDefaultProjectImage, startSandbox } from "../src/docker";

/**
 * `tail -f /dev/null` as PID1 ignores SIGTERM, so a plain `docker stop` blocks for the
 * full default timeout before SIGKILL finishes the job — `stop()` must remove the
 * container immediately and report whether teardown actually succeeded.
 */
describe("Sandbox teardown (W1)", () => {
  test("stop() removes the container immediately, well under the old 10s SIGTERM grace period", async () => {
    const image = await ensureDefaultProjectImage();
    const id = `w1-speed-${Date.now()}`;
    const sandbox = await startSandbox({ image, mountPath: "/tmp", env: {}, id });

    const startedAt = Date.now();
    const result = await sandbox.stop();
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(true);
    expect(elapsedMs).toBeLessThan(5_000);

    const inspect = Bun.spawnSync(["docker", "inspect", sandbox.containerId], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(inspect.exitCode).not.toBe(0); // the container is actually gone, not just stopped
  }, 60_000);

  test("the container carries a crisol-<id> name and a crisol.run=<id> label", async () => {
    const image = await ensureDefaultProjectImage();
    // A unique id, never a fixed literal — a leftover container from a prior crashed run
    // with the SAME name would otherwise make `docker run --name` collide.
    const id = `w1-name-label-test-${Date.now()}`;
    const sandbox = await startSandbox({ image, mountPath: "/tmp", env: {}, id });
    try {
      const inspect = Bun.spawnSync(
        [
          "docker",
          "inspect",
          "--format",
          '{{.Name}}|{{index .Config.Labels "crisol.run"}}',
          sandbox.containerId,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(inspect.exitCode).toBe(0);
      const [name, label] = inspect.stdout.toString("utf8").trim().split("|");
      expect(name).toBe(`/crisol-${id}`);
      expect(label).toBe(id);
    } finally {
      await sandbox.stop();
    }
  }, 30_000);

  /**
   * `run.ts` calls `stop()` from inside its own `finally` block, so a throw there is
   * load-bearing — it would REPLACE whatever primary error was propagating and leak the
   * container. Mutating `process.env.PATH` reproduces the spawn-throw deterministically,
   * the same technique `git-validation.test.ts` uses for `GIT_CONFIG_GLOBAL`/`SYSTEM`.
   */
  describe("Sandbox.stop() and exec() survive a spawn throw (finding 3)", () => {
    test("stop() resolves to ok:false with the spawn error instead of rejecting when docker vanishes from PATH", async () => {
      const image = await ensureDefaultProjectImage();
      const id = `w3-stop-spawn-throw-${Date.now()}`;
      const sandbox = await startSandbox({ image, mountPath: "/tmp", env: {}, id });
      const originalPath = process.env.PATH;
      try {
        process.env.PATH = "/nonexistent-path-for-crisol-test";
        await expect(sandbox.stop()).resolves.toMatchObject({ ok: false });
      } finally {
        process.env.PATH = originalPath;
        await sandbox.stop(); // docker is resolvable again — actually clean up
      }
    }, 30_000);

    test("exec() resolves to a normal ExecResult (exitCode -1) instead of rejecting when docker vanishes from PATH", async () => {
      const image = await ensureDefaultProjectImage();
      const id = `w3-exec-spawn-throw-${Date.now()}`;
      const sandbox = await startSandbox({ image, mountPath: "/tmp", env: {}, id });
      const originalPath = process.env.PATH;
      try {
        process.env.PATH = "/nonexistent-path-for-crisol-test";
        await expect(sandbox.exec(["echo", "hi"])).resolves.toMatchObject({ exitCode: -1 });
      } finally {
        process.env.PATH = originalPath;
        await sandbox.stop();
      }
    }, 30_000);
  });
});
