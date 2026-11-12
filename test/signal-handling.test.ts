import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Adapter, AdapterContext } from "../src/adapter";
import { run } from "../src/run";
import { runLogPath } from "../src/paths";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * `process.emit("SIGINT", ...)` fires the exact listeners `run()` installs — Node/Bun's
 * `process` is a plain EventEmitter for signals — without needing a real OS-level signal
 * or a subprocess.
 */
describe("Ctrl+C tears the Sandbox down and still runs Fetch-back (finding 6)", () => {
  test("SIGINT during the Adapter's work stops the container and still leaves the branch in the host repo", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      let launchStarted = false;
      let containerId = "";
      const slowAdapter: Adapter = {
        declarePreStart() {
          return { envNames: [], mounts: [] };
        },
        async launch(ctx: AdapterContext) {
          launchStarted = true;
          containerId = ctx.sandbox.containerId;
          // Long enough that the signal always arrives well before this resolves on its own.
          await ctx.sandbox.exec(["sleep", "30"]);
        },
        async reportCompletion() {
          return true;
        },
        async resumeWithFeedback() {},
      };

      const runPromise = run({ task: "x", cwd: repo.path, home: home.path, adapter: slowAdapter });

      await waitFor(() => launchStarted);
      // A tick so the signal handlers are in place before the signal fires.
      await new Promise((resolve) => setTimeout(resolve, 50));

      process.emit("SIGINT", "SIGINT");

      await expect(runPromise).rejects.toThrow(/Interrupted by SIGINT/i);

      // The container must actually be gone, not just "stopped".
      expect(containerId).not.toBe("");
      const inspect = Bun.spawnSync(["docker", "inspect", containerId], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(inspect.exitCode).not.toBe(0);

      // Fetch-back still ran despite the interrupt.
      const runs = Bun.spawnSync(["ls", `${home.path}/runs`], { stdout: "pipe" })
        .stdout.toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(runs).toHaveLength(1);
      const runId = runs[0]!;
      const log = readFileSync(runLogPath(runId, home.path), "utf8");
      expect(log).toContain("received SIGINT; tearing the Sandbox down");
      expect(log).toContain("fetch-back complete");

      const branchCheck = Bun.spawnSync(
        ["git", "-C", repo.path, "show-ref", "--verify", "--quiet", `refs/heads/crisol/${runId}`],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(branchCheck.exitCode).toBe(0);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 30_000);

  /**
   * Regression test for the OLD code's handler-removal window: `process.off` ran right
   * after the Adapter's race settled, so a second signal landing during teardown/Fetch-back
   * hit no listener (a silent no-op). The first SIGINT is identical to the test above; the
   * short delay after it reliably lands the SECOND one inside the teardown+Fetch-back
   * window, since `docker rm -f` plus Fetch-back's own git calls take measurably longer.
   */
  test("a SECOND SIGINT during teardown/Fetch-back is still logged, not silently lost", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      let launchStarted = false;
      const slowAdapter: Adapter = {
        declarePreStart() {
          return { envNames: [], mounts: [] };
        },
        async launch(ctx: AdapterContext) {
          launchStarted = true;
          await ctx.sandbox.exec(["sleep", "30"]);
        },
        async reportCompletion() {
          return true;
        },
        async resumeWithFeedback() {},
      };

      const runPromise = run({ task: "x", cwd: repo.path, home: home.path, adapter: slowAdapter });

      await waitFor(() => launchStarted);
      await new Promise((resolve) => setTimeout(resolve, 50));

      process.emit("SIGINT", "SIGINT"); // first: interrupts the Adapter's work
      await new Promise((resolve) => setTimeout(resolve, 60));
      process.emit("SIGINT", "SIGINT"); // second: lands during teardown/Fetch-back

      await expect(runPromise).rejects.toThrow(/Interrupted by SIGINT/i);

      const runs = Bun.spawnSync(["ls", `${home.path}/runs`], { stdout: "pipe" })
        .stdout.toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(runs).toHaveLength(1);
      const log = readFileSync(runLogPath(runs[0]!, home.path), "utf8");
      const receivedCount = log.split("\n").filter((line) => line.includes("received SIGINT")).length;
      // Both signals must be logged — the second one only if the handler
      // was still attached when it arrived.
      expect(receivedCount).toBeGreaterThanOrEqual(2);
      expect(log).toContain("fetch-back complete");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 30_000);
});
