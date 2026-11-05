import { describe, expect, test } from "bun:test";
import { ensureBaseImage, startSandbox } from "../src/docker";

/**
 * W1: teardown must not wait out the 10s SIGTERM grace period. `tail -f
 * /dev/null` as PID1 ignores SIGTERM, so a plain `docker stop` blocks for
 * the full default timeout before SIGKILL finishes the job. `stop()` must
 * remove the container immediately (`docker rm -f`) and report whether
 * teardown actually succeeded — never claim "stopped" on failure. The
 * container also carries a `crisol-<id>` name and a `crisol.run=<id>` label.
 */
describe("Sandbox teardown (W1)", () => {
  test("stop() removes the container immediately, well under the old 10s SIGTERM grace period", async () => {
    const image = await ensureBaseImage();
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
  }, 30_000);

  test("the container carries a crisol-<id> name and a crisol.run=<id> label", async () => {
    const image = await ensureBaseImage();
    // Extra (round-2 review): a unique id, never a fixed literal — a
    // leftover container from a prior crashed run with the SAME name would
    // otherwise make `docker run --name` collide and fail this test.
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
   * Round-3 review, finding 3 (CONFIRMED): `Bun.spawn` can THROW
   * synchronously (e.g. the `docker` binary vanishing from PATH) rather
   * than merely returning a non-zero exit code — `assertDockerReachable`'s
   * own `isEnoent` catch already guards the ONE pre-check call against
   * this, but `stop()`/`exec()`'s own spawns did not. Left uncaught, a
   * throw from `sandbox.stop()` is load-bearing: `run.ts` calls it from
   * inside its OWN `finally` block (fix W1), and a throw from WITHIN a
   * `finally` always REPLACES whatever primary error (e.g. an Adapter
   * failure) was already propagating — silently masking it AND leaking the
   * container (never actually removed).
   *
   * Mutating `process.env.PATH` directly reproduces the failure
   * deterministically, the same technique `git-validation.test.ts` already
   * uses for `GIT_CONFIG_GLOBAL`/`SYSTEM` — it only works once `stop`/`exec`
   * pass `env: process.env` to their own spawns (same fix, bundled here).
   */
  describe("Sandbox.stop() and exec() survive a spawn throw (finding 3)", () => {
    test("stop() resolves to ok:false with the spawn error instead of rejecting when docker vanishes from PATH", async () => {
      const image = await ensureBaseImage();
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
      const image = await ensureBaseImage();
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
