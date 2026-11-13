import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { startCli, waitFor } from "./support/liveCli";
import { readLog, readResult, refSha, removeRunContainers, runIds, stopRuns } from "./support/runState";

function statusLine(stdout: string, id: string): string {
  const line = stdout.split("\n").find((entry) => entry.startsWith(id));
  if (!line) throw new Error(`no line for Run ${id} in:\n${stdout}`);
  return line;
}

describe("crisol run --detach", () => {
  test("returns at once with the run id; the Run completes on its own and writes result.json", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    let id: string | undefined;
    try {
      const detached = await runCli(["run", "x", "--detach", "--gate", "sleep 8"], {
        cwd: repo.path,
        home: home.path,
      });

      expect(detached.exitCode).toBe(0);
      id = detached.stdout.trim();
      expect(id).toMatch(/^[0-9a-f]{8}$/);
      expect(runIds(home.path)).toEqual([id]);
      expect(readResult(id, home.path)).toBeUndefined();

      await waitFor(() => readResult(id!, home.path) !== undefined, 90_000);
      const result = readResult(id, home.path)!;
      expect(result.status).toBe("verified");
      expect(result.fetchBack).toBe(true);
      expect(refSha(repo.path, result.branch)).toBeDefined();
      expect(readLog(id, home.path)).toContain(`Run ${id}: branch ${result.branch}, status verified.`);
    } finally {
      await stopRuns(home.path);
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);

  test("a Run that fails pre-flight is reported by the detaching command and leaves nothing", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const detached = await runCli(["run", "x", "--detach", "--base", "no-such-ref"], {
        cwd: repo.path,
        home: home.path,
      });

      expect(detached.exitCode).not.toBe(0);
      expect(detached.stdout).toBe("");
      expect(detached.stderr).toContain("no-such-ref");
      expect(runIds(home.path)).toEqual([]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("is refused with several Tasks or with --json, before anything runs", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const fanOut = await runCli(["run", "a", "b", "--detach"], { cwd: repo.path, home: home.path });
      expect(fanOut.exitCode).not.toBe(0);
      expect(fanOut.stderr).toContain("--detach");

      const json = await runCli(["run", "a", "--detach", "--json"], { cwd: repo.path, home: home.path });
      expect(json.exitCode).not.toBe(0);
      expect(json.stderr).toContain("--detach");

      expect(runIds(home.path)).toEqual([]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("stopping a detached Run", () => {
  test("status shows its pid; SIGTERM to it stops a queued Run and a running one, and both stay listed", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const ids: string[] = [];
    try {
      writeFileSync(path.join(home.path, "config"), "max_parallel = 1\n");

      const running = await runCli(["run", "a", "--detach", "--gate", "sleep 60"], { cwd: repo.path, home: home.path });
      ids.push(running.stdout.trim());
      await waitFor(() => readLog(ids[0]!, home.path).includes(" started from "));
      const queued = await runCli(["run", "b", "--detach"], { cwd: repo.path, home: home.path });
      ids.push(queued.stdout.trim());
      await waitFor(() => readLog(ids[1]!, home.path).includes("Waiting for a free Slot"));

      const live = await runCli(["status"], { cwd: repo.path, home: home.path });
      const pidOf = (id: string) => Number(/pid (\d+)/.exec(statusLine(live.stdout, id))?.[1]);
      const [runningPid, queuedPid] = [pidOf(ids[0]!), pidOf(ids[1]!)];
      expect(queued.stderr).toContain(`pid ${queuedPid}`);

      process.kill(queuedPid, "SIGTERM");
      await waitFor(() => readResult(ids[1]!, home.path) !== undefined);
      const queuedResult = readResult(ids[1]!, home.path)!;
      expect(queuedResult.status).toBe("not-converged");
      expect(queuedResult.reason).toBe("interrupted: SIGTERM");
      expect(refSha(repo.path, queuedResult.branch)).toBeUndefined();
      const afterQueued = await runCli(["status"], { cwd: repo.path, home: home.path });
      expect(statusLine(afterQueued.stdout, ids[1]!)).toContain("interrupted: SIGTERM");
      const logs = await runCli(["logs", ids[1]!], { cwd: repo.path, home: home.path });
      expect(logs.exitCode).toBe(0);
      expect(logs.stdout).toContain("ended before it held a Slot");

      process.kill(runningPid, "SIGTERM");
      await waitFor(() => readResult(ids[0]!, home.path) !== undefined);
      const runningResult = readResult(ids[0]!, home.path)!;
      expect(runningResult.reason).toBe("interrupted: SIGTERM");
      expect(runningResult.fetchBack).toBe(true);
      expect(refSha(repo.path, runningResult.branch)).toBeDefined();
    } finally {
      await stopRuns(home.path);
      home.cleanup();
      repo.cleanup();
    }
  }, 150_000);
});

describe("crisol status", () => {
  test("shows a queued Run as queued, a running Run as running, and each finished Run with its Status", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const ids: string[] = [];
    try {
      writeFileSync(path.join(home.path, "config"), "max_parallel = 1\n");

      const first = await runCli(["run", "first", "--detach", "--gate", "sleep 6"], { cwd: repo.path, home: home.path });
      ids.push(first.stdout.trim());
      await waitFor(() => readLog(ids[0]!, home.path).includes(" started from "));
      const second = await runCli(["run", "second", "--detach"], { cwd: repo.path, home: home.path });
      ids.push(second.stdout.trim());
      await waitFor(() => readLog(ids[1]!, home.path).includes("Waiting for a free Slot"));

      const live = await runCli(["status"], { cwd: repo.path, home: home.path });
      expect(live.exitCode).toBe(0);
      expect(statusLine(live.stdout, ids[0]!)).toContain("running");
      expect(statusLine(live.stdout, ids[1]!)).toContain("queued");

      await waitFor(() => ids.every((id) => readResult(id, home.path) !== undefined), 90_000);
      const done = await runCli(["status"], { cwd: repo.path, home: home.path });
      expect(statusLine(done.stdout, ids[0]!)).toContain("verified");
      expect(statusLine(done.stdout, ids[0]!)).toContain(`crisol/${ids[0]}`);
      expect(statusLine(done.stdout, ids[1]!)).toContain("unverified");
    } finally {
      await stopRuns(home.path);
      home.cleanup();
      repo.cleanup();
    }
  }, 150_000);

  test("names a Run that died without its Run result as dead", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    let id: string | undefined;
    try {
      const cli = startCli(["run", "x", "--gate", "sleep 120"], { cwd: repo.path, home: home.path });
      await waitFor(() => runIds(home.path).length === 1);
      id = runIds(home.path)[0]!;
      await waitFor(() => readLog(id!, home.path).includes("adapter reported completion"));
      process.kill(cli.proc.pid, "SIGKILL");
      await cli.finished();

      const status = await runCli(["status"], { cwd: repo.path, home: home.path });

      expect(status.exitCode).toBe(0);
      expect(statusLine(status.stdout, id)).toContain("dead");
    } finally {
      if (id) removeRunContainers(id);
      home.cleanup();
      repo.cleanup();
    }
  }, 90_000);

  test("says so when there are no Runs", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const status = await runCli(["status"], { cwd: repo.path, home: home.path });
      expect(status.exitCode).toBe(0);
      expect(status.stdout.trim()).toBe("No Runs.");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("crisol logs", () => {
  test("prints that Run's log", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x"], { cwd: repo.path, home: home.path });
      const id = runIds(home.path)[0]!;
      expect(done.exitCode).toBe(0);

      const logs = await runCli(["logs", id], { cwd: repo.path, home: home.path });

      expect(logs.exitCode).toBe(0);
      expect(logs.stdout).toBe(readLog(id, home.path));
      expect(logs.stdout).toContain(`run ${id} starting`);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("an unknown id fails with a plain message, and never reads outside the runs dir", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const unknown = await runCli(["logs", "deadbeef"], { cwd: repo.path, home: home.path });
      expect(unknown.exitCode).not.toBe(0);
      expect(unknown.stdout).toBe("");
      expect(unknown.stderr.trim()).toBe('No Run "deadbeef". `crisol status` lists every Run.');

      const escape = await runCli(["logs", "../config"], { cwd: repo.path, home: home.path });
      expect(escape.exitCode).not.toBe(0);
      expect(escape.stderr).toContain('No Run "../config"');
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});
