import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDockerMemorySize, parseGlobalConfig, parsePositiveNumber } from "../src/config";
import { ensureDefaultProjectImage, startSandbox } from "../src/docker";
import { FakeAdapter, simulateProviderFailure } from "../src/adapters/fake";
import { resolveCapacityLimits, run } from "../src/run";
import type { RunFailure, RunResult } from "../src/run";
import { runLogPath } from "../src/paths";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await Bun.sleep(25);
  }
}

describe("ticket 13: a provider failure is not a red Gate", () => {
  test('Fake Adapter "simulate a rate limit" -> not-converged, reason names the provider failure, no iterations spent', async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({
        task: "x",
        cwd: repo.path,
        home: home.path,
        adapter: simulateProviderFailure("rate limit", "Claude AI usage limit reached; resets at 3pm."),
        gates: ["true"],
      });

      expect(result.status).toBe("not-converged");
      expect(result.reason).toBe("provider: rate limit");
      expect(result.iterations).toBe(0);
      expect(result.gates).toEqual([]);
      expect(result.fetchBack).toBe(true);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("with a queued Run waiting, a provider failure keeps the queued Run from starting", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "config"), "max_parallel = 1\n");
      const controller = new AbortController();
      const shared = {
        cwd: repo.path,
        home: home.path,
        signal: controller.signal,
        onProviderFailure: (reason: string) => controller.abort(reason),
      };

      // The first Run holds the only Slot and fails on a provider error. `generateRunId` gives a
      // fixed id so its Clone dir can be waited on, proving it really holds the Slot before the
      // second Run starts.
      const first = run({
        ...shared,
        task: "a",
        generateRunId: () => "aaaa1111",
        adapter: simulateProviderFailure("rate limit"),
      });
      await waitFor(() => {
        try {
          return readFileSync(runLogPath("aaaa1111", home.path), "utf8").includes("run aaaa1111 starting");
        } catch {
          return false;
        }
      });

      let secondWaiting = false;
      const second = run({
        ...shared,
        task: "b",
        generateRunId: () => "bbbb2222",
        adapter: new FakeAdapter(),
        onSlotWait: () => {
          secondWaiting = true;
        },
      });
      await waitFor(() => secondWaiting);

      const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);

      // A provider failure resolves: a not-converged outcome, not an error.
      expect(firstOutcome.status).toBe("fulfilled");
      expect((firstOutcome as PromiseFulfilledResult<RunResult>).value.reason).toBe("provider: rate limit");

      expect(secondOutcome.status).toBe("rejected");
      const secondError = (secondOutcome as PromiseRejectedResult).reason;
      const secondResult = (secondError as RunFailure).result;
      expect(secondResult?.status).toBe("not-converged");
      expect(secondResult?.reason).toBe("interrupted: provider: rate limit");
      expect(secondResult?.fetchBack).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("ticket 13: per-container capacity limits", () => {
  test("the Sandbox is created with the default 2 CPUs and 4 GB limits", async () => {
    const image = await ensureDefaultProjectImage();
    const id = `capacity-default-${Date.now()}`;
    const mountPath = mkdtempSync(path.join(tmpdir(), "crisol-capacity-probe-"));
    const sandbox = await startSandbox({ image, mountPath, env: {}, id });
    try {
      const inspect = Bun.spawnSync(
        ["docker", "inspect", "--format", "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}", sandbox.containerId],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(inspect.exitCode).toBe(0);
      const [nanoCpus, memory] = inspect.stdout.toString("utf8").trim().split(" ");
      expect(Number(nanoCpus)).toBe(2_000_000_000); // 2 CPUs
      expect(Number(memory)).toBe(4 * 1024 * 1024 * 1024); // 4 GiB
    } finally {
      await sandbox.stop();
      rmSync(mountPath, { recursive: true, force: true });
    }
  }, 30_000);

  test("an explicit cpus/memory overrides the default, enforced down to the container's own cgroup", async () => {
    const image = await ensureDefaultProjectImage();
    const id = `capacity-override-${Date.now()}`;
    const mountPath = mkdtempSync(path.join(tmpdir(), "crisol-capacity-probe-"));
    const sandbox = await startSandbox({ image, mountPath, env: {}, id, cpus: 1, memory: "256m" });
    try {
      const inspect = Bun.spawnSync(
        ["docker", "inspect", "--format", "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}", sandbox.containerId],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(inspect.exitCode).toBe(0);
      const [nanoCpus, memory] = inspect.stdout.toString("utf8").trim().split(" ");
      expect(Number(nanoCpus)).toBe(1_000_000_000);
      expect(Number(memory)).toBe(256 * 1024 * 1024);

      // The cgroup Docker's own flags configure, not just the API's recorded intent.
      const cgroup = await sandbox.exec(["cat", "/sys/fs/cgroup/memory.max"]);
      expect(cgroup.stdout.trim()).toBe(String(256 * 1024 * 1024));
    } finally {
      await sandbox.stop();
      rmSync(mountPath, { recursive: true, force: true });
    }
  }, 30_000);

  test("~/.crisol/config's cpus/memory reach the Sandbox `run()` actually starts", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "config"), "cpus = 1.5\nmemory = 512m\n");

      const result = await run({
        task: "x",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter(),
      });

      expect(result.status).toBe("unverified");
      const log = readFileSync(runLogPath(result.run, home.path), "utf8");
      expect(log).toContain("sandbox capacity: cpus=1.5, memory=512m");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("~/.crisol/config's cpus/memory parsing", () => {
  test("parses alongside the other keys", () => {
    expect(parseGlobalConfig("cpus = 1.5\nmemory = 512m\nmax_parallel = 2\n", "config")).toEqual({
      cpus: 1.5,
      memory: "512m",
      maxParallel: 2,
    });
  });

  test("rejects a non-numeric cpus, naming the source and the key", () => {
    expect(() => parseGlobalConfig('cpus = "two"', "/home/.crisol/config")).toThrow(
      /\/home\/\.crisol\/config.*cpus/,
    );
  });

  test("rejects a memory value with no Docker-recognised suffix", () => {
    expect(() => parseGlobalConfig("memory = 4gb", "/home/.crisol/config")).toThrow(/memory/);
  });

  test("resolveCapacityLimits defaults to 2 CPUs and 4 GB", () => {
    expect(resolveCapacityLimits({})).toEqual({ cpus: 2, memory: "4g" });
    expect(resolveCapacityLimits({ cpus: 1, memory: "1g" })).toEqual({ cpus: 1, memory: "1g" });
  });

  test("parsePositiveNumber/parseDockerMemorySize accept the documented forms", () => {
    expect(parsePositiveNumber("2")).toBe(2);
    expect(parsePositiveNumber("1.5")).toBe(1.5);
    expect(parsePositiveNumber("0")).toBeUndefined();
    expect(parsePositiveNumber("-1")).toBeUndefined();
    expect(parseDockerMemorySize("4g")).toBe("4g");
    expect(parseDockerMemorySize("512m")).toBe("512m");
    expect(parseDockerMemorySize("0g")).toBeUndefined();
    expect(parseDockerMemorySize("4gb")).toBeUndefined();
  });
});
