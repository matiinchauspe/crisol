import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { planGc } from "../src/gc";
import { shortSha } from "../src/git";
import { runLockPath, runRepoPath, runResultPath } from "../src/paths";
import type { RunResult } from "../src/run";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { startCli, waitFor } from "./support/liveCli";
import {
  cloneSha,
  onlyRunId,
  readLog,
  readResult,
  refSha,
  removeRunContainers,
  runContainers,
  runIds,
  runNetworkExists,
} from "./support/runState";

function git(repoPath: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString("utf8")}`);
  return proc.stdout.toString("utf8").trim();
}

/** `run()` writes `fetchBack: false` when its own Fetch-back threw, leaving the branch for recover. */
function markFetchBackFailed(id: string, home: string): void {
  const result = JSON.parse(readFileSync(runResultPath(id, home), "utf8")) as RunResult;
  writeFileSync(runResultPath(id, home), JSON.stringify({ ...result, fetchBack: false }, null, 2));
}

describe("crisol recover", () => {
  test("after SIGKILL mid-Run the branch is missing; recover brings it to the host at the Clone's commit", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    let id: string | undefined;
    try {
      const cli = startCli(["run", "x", "--gate", "sleep 120", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      await waitFor(() => runIds(home.path).length === 1);
      id = runIds(home.path)[0]!;
      await waitFor(() => readLog(id!, home.path).includes("adapter reported completion"));

      process.kill(cli.proc.pid, "SIGKILL");
      await cli.finished();

      const branch = `crisol/${id}`;
      expect(refSha(repo.path, branch)).toBeUndefined();
      expect(readResult(id, home.path)).toBeUndefined();

      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });

      expect(recovered.exitCode).toBe(0);
      expect(recovered.stdout).toContain(`Run ${id}: recovered ${branch}`);
      expect(refSha(repo.path, branch)).toBe(cloneSha(id, home.path, branch)!);
      // A dead Run's agent could otherwise keep committing to the Clone after recover read it.
      expect(runContainers(id)).toEqual([]);
      expect(runNetworkExists(id)).toBe(false);
      expect(readLog(id, home.path)).toContain("recover: fetch-back complete");
    } finally {
      if (id) removeRunContainers(id);
      home.cleanup();
      repo.cleanup();
    }
  }, 90_000);

  test("never touches a Run that is still live", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    let id: string | undefined;
    try {
      const cli = startCli(["run", "x", "--gate", "sleep 60", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      await waitFor(() => runIds(home.path).length === 1);
      id = runIds(home.path)[0]!;
      await waitFor(() => readLog(id!, home.path).includes("adapter reported completion"));

      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });

      expect(recovered.exitCode).toBe(0);
      expect(recovered.stdout).toContain(`Run ${id}: live`);
      expect(refSha(repo.path, `crisol/${id}`)).toBeUndefined();
      // The Sandbox AND the Allowlist proxy — both share the Run's label, both alive.
      expect(runContainers(id)).toHaveLength(2);
      expect(readLog(id, home.path)).not.toContain("recover:");

      process.kill(-cli.proc.pid, "SIGINT");
      await cli.finished();
    } finally {
      if (id) removeRunContainers(id);
      home.cleanup();
      repo.cleanup();
    }
  }, 90_000);

  test("fast-forwards a host branch that is behind the Clone of a Run whose Fetch-back failed", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      const result = JSON.parse(done.stdout) as RunResult;
      markFetchBackFailed(result.run, home.path);
      Bun.spawnSync(["git", "-C", runRepoPath(result.run, home.path), "commit", "--quiet", "--allow-empty", "-m", "late"]);
      const behind = refSha(repo.path, result.branch);
      const ahead = cloneSha(result.run, home.path, result.branch)!;
      expect(behind).not.toBe(ahead);

      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });

      expect(recovered.exitCode).toBe(0);
      expect(refSha(repo.path, result.branch)).toBe(ahead);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("with Docker unreachable it still fetches back, and warns instead of removing the network", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      const result = JSON.parse(done.stdout) as RunResult;
      markFetchBackFailed(result.run, home.path);
      Bun.spawnSync(["git", "-C", runRepoPath(result.run, home.path), "commit", "--quiet", "--allow-empty", "-m", "late"]);
      const ahead = cloneSha(result.run, home.path, result.branch)!;

      const recovered = await runCli(["recover"], {
        cwd: repo.path,
        home: home.path,
        env: { DOCKER_HOST: "unix:///nonexistent-crisol-test.sock" },
      });

      expect(recovered.exitCode).toBe(0);
      expect(recovered.stdout).toContain(`Run ${result.run}: recovered ${result.branch}`);
      expect(recovered.stderr).toContain("Docker could not be asked");
      expect(refSha(repo.path, result.branch)).toBe(ahead);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("says so when there is nothing to recover", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      await runCli(["run", "x", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      const id = onlyRunId(home.path);

      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });

      expect(recovered.exitCode).toBe(0);
      expect(recovered.stdout.trim()).toBe("Nothing to recover.");
      expect(readLog(id, home.path)).not.toContain("recover:");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

/**
 * A Continuation round that died after its agent amended the branch: the lock record is what
 * `reserveContinuation` writes for that round, its `roundStart` the host sha pre-flight proved.
 */
function amendInDeadContinuation(id: string, home: string, host: string, branch: string): string {
  const record = JSON.parse(readFileSync(runLockPath(id, home), "utf8")) as Record<string, unknown>;
  writeFileSync(runLockPath(id, home), JSON.stringify({ ...record, roundStart: refSha(host, branch) }));
  markFetchBackFailed(id, home);
  git(runRepoPath(id, home), ["commit", "--quiet", "--amend", "--allow-empty", "-m", "fix: amended by the next round"]);
  return cloneSha(id, home, branch)!;
}

describe("recover after the agent rewrote its branch", () => {
  test("brings back a branch amended in a round that died, from where that round began", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      const result = JSON.parse(done.stdout) as RunResult;
      const amended = amendInDeadContinuation(result.run, home.path, repo.path, result.branch);

      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });

      expect(recovered.exitCode).toBe(0);
      expect(recovered.stdout).toContain(`Run ${result.run}: recovered ${result.branch}`);
      expect(refSha(repo.path, result.branch)).toBe(amended);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("refuses a host branch that moved since that round began, naming both shas, and leaves it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      const result = JSON.parse(done.stdout) as RunResult;
      const roundStart = refSha(repo.path, result.branch)!;
      amendInDeadContinuation(result.run, home.path, repo.path, result.branch);
      const hostCommit = git(repo.path, ["commit-tree", `${result.branch}^{tree}`, "-p", result.branch, "-m", "user's own follow-up"]);
      git(repo.path, ["update-ref", `refs/heads/${result.branch}`, hostCommit]);

      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });

      expect(recovered.exitCode).toBe(1);
      expect(recovered.stderr).toContain(`Run ${result.run}: FAILED`);
      expect(recovered.stderr).toContain(roundStart);
      expect(recovered.stderr).toContain(hostCommit);
      expect(refSha(repo.path, result.branch)).toBe(hostCommit);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("recover settles only dead Runs, and every dead Run", () => {
  test("a Run killed in its first round is settled from its lock record, so status, gc and --continue all see it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const branch = "killed/first-round";
    let id: string | undefined;
    try {
      const baseSha = shortSha(repo.path, "main");
      const cli = startCli(["run", "x", "--gate", "sleep 120", "--name", branch, "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      await waitFor(() => runIds(home.path).length === 1);
      id = runIds(home.path)[0]!;
      await waitFor(() => readLog(id!, home.path).includes("adapter reported completion"));
      process.kill(cli.proc.pid, "SIGKILL");
      await cli.finished();
      removeRunContainers(id);
      expect(readResult(id, home.path)).toBeUndefined();

      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });
      expect(recovered.exitCode).toBe(0);

      const settled = readResult(id, home.path)!;
      // The run was started with no --base, so it was cut from main.
      expect(settled).toMatchObject({
        run: id,
        branch,
        base: `main@${baseSha}`,
        status: "not-converged",
        adapter: "fake",
        network: "allowlist",
        fetchBack: true,
      });
      expect(settled.reason).toContain("interrupted");

      const status = await runCli(["status"], { cwd: repo.path, home: home.path });
      const line = status.stdout.split("\n").find((entry) => entry.startsWith(id!));
      expect(line).toContain("not-converged");
      expect(line).not.toContain("dead");

      expect(planGc(home.path, { includeFailed: true }).skipped).toContainEqual(
        expect.objectContaining({ run: id, kind: "too-young" }),
      );

      const continued = await runCli(["run", "--continue", branch, "finish it", "--gate", "true", "--json"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(continued.exitCode).toBe(0);
      expect(JSON.parse(continued.stdout) as RunResult).toMatchObject({ run: id, branch, status: "verified", fetchBack: true });
    } finally {
      if (id) removeRunContainers(id);
      home.cleanup();
      repo.cleanup();
    }
  }, 180_000);

  test("a finished Run whose branch was merged and deleted is left alone, never re-created", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      const result = JSON.parse(done.stdout) as RunResult;
      git(repo.path, ["merge", "--quiet", "--ff-only", result.branch]);
      git(repo.path, ["branch", "--quiet", "-d", result.branch]);

      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });

      expect(recovered.exitCode).toBe(0);
      expect(recovered.stdout.trim()).toBe("Nothing to recover.");
      expect(refSha(repo.path, result.branch)).toBeUndefined();
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a finished Run whose branch the user advanced is left alone, and recover exits 0", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      const result = JSON.parse(done.stdout) as RunResult;
      const advanced = git(repo.path, ["commit-tree", `${result.branch}^{tree}`, "-p", result.branch, "-m", "user's own follow-up"]);
      git(repo.path, ["update-ref", `refs/heads/${result.branch}`, advanced]);

      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });

      expect(recovered.exitCode).toBe(0);
      expect(recovered.stdout.trim()).toBe("Nothing to recover.");
      expect(refSha(repo.path, result.branch)).toBe(advanced);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});
