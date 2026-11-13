import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runLogPath, runRepoPath, runResultPath, runsRoot } from "../src/paths";
import type { RunResult } from "../src/run";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");

/** A live `crisol run` process, so a test can watch it queue and kill it mid-Run. */
function startCli(args: string[], cwd: string, home: string) {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, CRISOL_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderr = "";
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) stderr += decoder.decode(chunk);
  })();
  const stdout = new Response(proc.stdout).text();
  return {
    proc,
    stderr: () => stderr,
    async finished() {
      const exitCode = await proc.exited;
      await stderrDone;
      return { exitCode, stdout: await stdout, stderr };
    },
  };
}

function runIds(home: string): string[] {
  return existsSync(runsRoot(home)) ? readdirSync(runsRoot(home)) : [];
}

async function waitFor(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}

function logTime(log: string, marker: string): number {
  const line = log.split("\n").find((entry) => entry.includes(marker));
  if (!line) throw new Error(`no "${marker}" line in log:\n${log}`);
  return Date.parse(line.slice(1, line.indexOf("]")));
}

describe("Slots across processes (max_parallel = 1)", () => {
  test("a second crisol run from another process waits until the first ends", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "config"), "max_parallel = 1\n");

      const first = startCli(["run", "first", "--gate", "sleep 3", "--json"], repo.path, home.path);
      await waitFor(() => runIds(home.path).length === 1);
      const [firstId] = runIds(home.path);

      const second = startCli(["run", "second", "--json"], repo.path, home.path);
      await waitFor(() => second.stderr().includes("Waiting for a free Slot"));
      // Reserved but queued: it has a run dir, and no Clone until it holds the Slot.
      const queuedId = runIds(home.path).find((id) => id !== firstId)!;
      expect(existsSync(runRepoPath(queuedId, home.path))).toBe(false);

      const firstDone = await first.finished();
      expect(firstDone.exitCode).toBe(0);
      const secondDone = await second.finished();
      expect(secondDone.exitCode).toBe(0);

      const secondResult = JSON.parse(secondDone.stdout) as RunResult;
      const firstLog = readFileSync(runLogPath(firstId!, home.path), "utf8");
      const secondLog = readFileSync(runLogPath(secondResult.run, home.path), "utf8");
      expect(logTime(secondLog, "starting:")).toBeGreaterThanOrEqual(logTime(firstLog, "result written"));
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);

  test("Ctrl+C on a queued Run stops it, keeps its log and Run result, and cuts no branch", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "config"), "max_parallel = 1\n");

      const first = startCli(["run", "first", "--gate", "sleep 3", "--json"], repo.path, home.path);
      await waitFor(() => runIds(home.path).length === 1);
      const [firstId] = runIds(home.path);

      const second = startCli(["run", "second", "--json"], repo.path, home.path);
      await waitFor(() => second.stderr().includes("Waiting for a free Slot"));
      second.proc.kill("SIGINT");

      const secondDone = await second.finished();
      expect(secondDone.exitCode).not.toBe(0);
      expect(secondDone.stderr).toContain("Interrupted while waiting for a Slot");
      const secondId = runIds(home.path).find((id) => id !== firstId)!;
      const secondResult = JSON.parse(readFileSync(runResultPath(secondId, home.path), "utf8")) as RunResult;
      expect(secondResult.status).toBe("not-converged");
      expect(secondResult.reason).toBe("interrupted: SIGINT");
      expect(secondResult.fetchBack).toBe(false);
      expect(readFileSync(runLogPath(secondId, home.path), "utf8")).toContain("ended before it held a Slot");
      expect(existsSync(runRepoPath(secondId, home.path))).toBe(false);
      const hostBranch = Bun.spawnSync(["git", "-C", repo.path, "branch", "--list", secondResult.branch], { stdout: "pipe" });
      expect(hostBranch.stdout.toString().trim()).toBe("");

      expect((await first.finished()).exitCode).toBe(0);
      // A Run that ended before its Clone has nothing to bring back, and recover does not name it.
      const recovered = Bun.spawnSync(["bun", "run", CLI_ENTRY, "recover"], {
        cwd: repo.path,
        env: { ...process.env, CRISOL_HOME: home.path },
        stdout: "pipe",
      });
      expect(recovered.stdout.toString().trim()).toBe("Nothing to recover.");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);

  test("after kill -9 of the first process, the waiting one proceeds", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    let firstId: string | undefined;
    try {
      writeFileSync(path.join(home.path, "config"), "max_parallel = 1\n");

      const first = startCli(["run", "first", "--gate", "sleep 120", "--json"], repo.path, home.path);
      await waitFor(() => runIds(home.path).length === 1);
      firstId = runIds(home.path)[0]!;
      await waitFor(() => readFileSync(runLogPath(firstId!, home.path), "utf8").includes(" started from "));

      const second = startCli(["run", "second", "--json"], repo.path, home.path);
      await waitFor(() => second.stderr().includes("Waiting for a free Slot"));

      first.proc.kill("SIGKILL");
      await first.proc.exited;

      const secondDone = await second.finished();
      expect(secondDone.exitCode).toBe(0);
      const secondResult = JSON.parse(secondDone.stdout) as RunResult;
      expect(secondResult.status).toBe("unverified");
      // The killed Run never got to finish: it was SIGKILLed, not drained.
      expect(existsSync(runResultPath(firstId, home.path))).toBe(false);
    } finally {
      // SIGKILL skips Crisol's own teardown, so the first Run's Sandbox is this test's to remove.
      if (firstId !== undefined) {
        Bun.spawnSync(["docker", "rm", "-f", `crisol-${firstId}`], { stdout: "ignore", stderr: "ignore" });
      }
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);
});
