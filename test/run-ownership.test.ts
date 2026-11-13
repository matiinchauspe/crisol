import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runDir, runLockPath, runPidPath, runRepoPath, runResultPath } from "../src/paths";
import { listRuns } from "../src/runs";
import { DarwinFlockSlotLock } from "../src/slots";
import type { HeldLock, SlotLock } from "../src/slots";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { startCli, waitFor } from "./support/liveCli";
import { readLog, readResult, runContainers, runIds, stopRuns } from "./support/runState";
import { wrapTools } from "./support/wrappedTools";

const HOLD_RUN_LOCK = path.join(import.meta.dir, "support", "holdRunLock.ts");

function pidFromDetach(stderr: string): number {
  const match = /detached as pid (\d+)/.exec(stderr);
  if (!match) throw new Error(`no pid in --detach's stderr:\n${stderr}`);
  return Number(match[1]);
}

/** A run dir as a Run leaves it once reserved: its lock file carrying the record, nothing else. */
function fakeRunDir(home: string, id: string, host: string): void {
  mkdirSync(runDir(id, home), { recursive: true });
  writeFileSync(runLockPath(id, home), JSON.stringify({ host, branch: `crisol/${id}` }));
}

describe("a detached Run always ends with a Run result", () => {
  test("killed the moment --detach returns, it still writes its Run result", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const detached = await runCli(["run", "x", "--detach"], { cwd: repo.path, home: home.path });
      process.kill(pidFromDetach(detached.stderr), "SIGTERM");
      const id = detached.stdout.trim();

      await waitFor(() => readResult(id, home.path) !== undefined, 30_000);
      const result = readResult(id, home.path)!;
      expect(result.status).toBe("not-converged");
      expect(result.reason).toBe("interrupted: SIGTERM");
      const status = await runCli(["status"], { cwd: repo.path, home: home.path });
      expect(status.stdout).not.toContain("dead");
    } finally {
      await stopRuns(home.path);
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a background process whose own pre-flight fails writes a not-converged Run result", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const tools = wrapTools([{ tool: "docker", subcommand: "info", mode: { kind: "pass-once" } }]);
    try {
      const env = { PATH: `${tools.binDir}:${process.env.PATH}` };
      const detached = await runCli(["run", "x", "--detach"], { cwd: repo.path, home: home.path, env });
      expect(detached.exitCode).toBe(0);
      const id = detached.stdout.trim();

      await waitFor(() => readResult(id, home.path) !== undefined, 30_000);
      const result = readResult(id, home.path)!;
      expect(result.status).toBe("not-converged");
      expect(result.reason).toContain("error: Docker engine is not reachable");
      const status = await runCli(["status"], { cwd: repo.path, home: home.path });
      expect(status.stdout).toContain("not-converged");
      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });
      expect(recovered.stdout.trim()).toBe("Nothing to recover.");
    } finally {
      await stopRuns(home.path);
      tools.cleanup();
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("status and recover never see it dead while --detach hands it over", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const detach = startCli(["run", "x", "--detach", "--gate", "sleep 3"], { cwd: repo.path, home: home.path });
      let detachDone = false;
      void detach.finished().then(() => {
        detachDone = true;
      });
      const seen: string[] = [];
      while (!detachDone || runIds(home.path).some((id) => readResult(id, home.path) === undefined)) {
        const [status, recovered] = await Promise.all([
          runCli(["status"], { cwd: repo.path, home: home.path }),
          runCli(["recover"], { cwd: repo.path, home: home.path }),
        ]);
        seen.push(status.stdout, recovered.stdout, recovered.stderr);
      }

      expect(seen.join("\n")).not.toMatch(/dead|skipped|recovered|FAILED/);
      expect(readResult(runIds(home.path)[0]!, home.path)!.status).toBe("verified");
    } finally {
      await stopRuns(home.path);
      home.cleanup();
      repo.cleanup();
    }
  }, 90_000);
});

describe("status trusts a pid only from the process that holds the Run", () => {
  test("a dead Run whose lock someone else holds shows dead, without its stale pid", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const id = "abcd1234";
    const holder = Bun.spawn(["bun", "run", HOLD_RUN_LOCK, runLockPath(id, home.path)], { stdout: "pipe" });
    try {
      fakeRunDir(home.path, id, repo.path);
      mkdirSync(runRepoPath(id, home.path));
      // A live process that never held this Run: what a reused pid looks like.
      writeFileSync(runPidPath(id, home.path), String(process.pid));
      const reader = holder.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain("held");

      const status = await runCli(["status"], { cwd: repo.path, home: home.path });

      expect(status.stdout.trim()).toBe(`${id}  dead           crisol/${id}`);
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
      home.cleanup();
      repo.cleanup();
    }
  }, 30_000);

  test("a Run that writes its result and lets go between status's two reads shows finished, never dead", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const id = "feed5678";
    try {
      fakeRunDir(home.path, id, repo.path);
      const real = new DarwinFlockSlotLock();
      const finishesFirst: SlotLock = {
        tryLock(lockPath, options): HeldLock | undefined {
          writeFileSync(runResultPath(id, home.path), JSON.stringify({ run: id, status: "verified", branch: `crisol/${id}` }));
          return real.tryLock(lockPath, options);
        },
      };

      const [entry] = listRuns(home.path, finishesFirst);

      expect(entry?.state).toBe("finished");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("Ctrl+C in a foreground pre-flight", () => {
  test("leaves no run dir, as a failed check does", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const tools = wrapTools([{ tool: "docker", subcommand: "info", mode: { kind: "stall", seconds: 4 } }]);
    try {
      const cli = startCli(["run", "x"], {
        cwd: repo.path,
        home: home.path,
        env: { PATH: `${tools.binDir}:${process.env.PATH}` },
      });
      await waitFor(() => tools.hits("docker", "info").length > 0);
      process.kill(cli.proc.pid, "SIGINT");

      const done = await cli.finished();

      expect(done.exitCode).not.toBe(0);
      expect(done.stderr).toContain("nothing was left behind");
      expect(runIds(home.path)).toEqual([]);
    } finally {
      tools.cleanup();
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("stopRuns, the suite's own cleanup", () => {
  test("stops a running and a queued detached Run, and nothing starts after it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "config"), "max_parallel = 1\n");
      const running = await runCli(["run", "a", "--detach", "--gate", "sleep 60"], { cwd: repo.path, home: home.path });
      const runningId = running.stdout.trim();
      await waitFor(() => readLog(runningId, home.path).includes(" started from "));
      const queuedId = (await runCli(["run", "b", "--detach"], { cwd: repo.path, home: home.path })).stdout.trim();
      await waitFor(() => readLog(queuedId, home.path).includes("Waiting for a free Slot"));

      await stopRuns(home.path);
      await Bun.sleep(3_000);

      for (const pid of [pidFromDetach(running.stderr)]) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      expect(runContainers(runningId)).toEqual([]);
      expect(runContainers(queuedId)).toEqual([]);
      expect(readResult(queuedId, home.path)?.reason).toBe("interrupted: SIGTERM");
    } finally {
      await stopRuns(home.path);
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);
});
