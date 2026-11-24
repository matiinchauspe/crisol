import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Adapter } from "../src/adapter";
import { checkoutNewBranch, cloneLocal, fetchBack } from "../src/git";
import { run } from "../src/run";
import type { RunResult } from "../src/run";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import type { FixtureRepo } from "./support/fixtureRepo";
import { startCli, waitFor } from "./support/liveCli";
import { cloneSha, onlyRunId, readLog, readResult, refSha, removeRunContainers, runContainers } from "./support/runState";
import { wrapTools } from "./support/wrappedTools";

describe("result.json records whether Fetch-back completed", () => {
  test("a Run that converges records fetchBack: true, in result.json and on stdout", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });

      expect(done.exitCode).toBe(0);
      const printed = JSON.parse(done.stdout) as RunResult;
      expect(printed.fetchBack).toBe(true);
      expect(readResult(printed.run, home.path)?.fetchBack).toBe(true);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a Run whose Fetch-back fails still writes result.json, with fetchBack: false", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const cloneDestroyingAdapter: Adapter = {
        declarePreStart() {
          return { envNames: [], mounts: [] };
        },
        async launch(ctx) {
          await ctx.sandbox.exec(["rm", "-rf", `${ctx.repoPath}/.git`]);
          throw new Error("adapter exploded");
        },
        async reportCompletion() {
          return true;
        },
        async resumeWithFeedback() {},
      };

      await expect(
        run({ task: "x", cwd: repo.path, home: home.path, adapter: cloneDestroyingAdapter }),
      ).rejects.toBeInstanceOf(AggregateError);

      expect(readResult(onlyRunId(home.path), home.path)).toMatchObject({
        status: "not-converged",
        reason: "error: adapter exploded",
        fetchBack: false,
      });
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("Fetch-back on a red-Gate exit", () => {
  test("a not-converged Run leaves its branch in the host at the Clone's commit", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--gate", "false", "--max-iterations", "1", "--json", "--adapter", "fake"], {
        cwd: repo.path,
        home: home.path,
      });

      expect(done.exitCode).toBe(0);
      const result = JSON.parse(done.stdout) as RunResult;
      expect(result).toMatchObject({ status: "not-converged", reason: "ceiling", fetchBack: true });
      expect(result.gates).toEqual([{ cmd: "false", ok: false }]);
      expect(refSha(repo.path, result.branch)).toBe(cloneSha(result.run, home.path, result.branch)!);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("a Fetch-back whose git process is killed", () => {
  test("is retried, and the branch still reaches the host", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const tools = wrapTools([{ tool: "git", subcommand: "fetch", mode: { kind: "stall", seconds: 3 } }]);
    try {
      const cli = startCli(["run", "x", "--json", "--adapter", "fake"], {
        cwd: repo.path,
        home: home.path,
        env: { PATH: `${tools.binDir}:${process.env.PATH}` },
      });
      // The first `git fetch` is the commit scan's; Fetch-back's is the second.
      await waitFor(() => tools.hits("git", "fetch").length === 2);
      process.kill(tools.hits("git", "fetch")[1]!, "SIGKILL");
      const done = await cli.finished();

      expect(done.exitCode).toBe(0);
      const result = JSON.parse(done.stdout) as RunResult;
      expect(result.fetchBack).toBe(true);
      expect(refSha(repo.path, result.branch)).toBe(cloneSha(result.run, home.path, result.branch)!);
      expect(tools.hits("git", "fetch")).toHaveLength(3);
      expect(readLog(result.run, home.path)).toContain("killed by SIGKILL; retrying");
    } finally {
      tools.cleanup();
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("a Sandbox that fails to stop", () => {
  test("is removed by its label on a second attempt, with no warning", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const tools = wrapTools([{ tool: "docker", subcommand: "rm", mode: { kind: "fail-once" } }]);
    let id: string | undefined;
    try {
      const done = await runCli(["run", "x", "--json", "--adapter", "fake"], {
        cwd: repo.path,
        home: home.path,
        env: { PATH: `${tools.binDir}:${process.env.PATH}` },
      });
      id = onlyRunId(home.path);

      expect(done.exitCode).toBe(0);
      expect(runContainers(id)).toEqual([]);
      expect((JSON.parse(done.stdout) as RunResult).warnings).toEqual([]);
      expect(readLog(id, home.path)).toContain(`removed by label crisol.run=${id}`);
    } finally {
      if (id) removeRunContainers(id);
      tools.cleanup();
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("that cannot be removed at all is named in warnings and on stderr", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const tools = wrapTools([{ tool: "docker", subcommand: "rm", mode: { kind: "fail-always" } }]);
    let id: string | undefined;
    try {
      const done = await runCli(["run", "x", "--json", "--adapter", "fake"], {
        cwd: repo.path,
        home: home.path,
        env: { PATH: `${tools.binDir}:${process.env.PATH}` },
      });
      id = onlyRunId(home.path);

      expect(done.exitCode).toBe(0);
      const warning = `Sandbox crisol-${id} could not be removed`;
      expect((JSON.parse(done.stdout) as RunResult).warnings.join("\n")).toContain(warning);
      expect(done.stderr).toContain(warning);
      // `docker rm` fails for every container now, not just the Sandbox's: the Allowlist
      // proxy's own removal fails the same way and is left running too.
      expect(runContainers(id)).toHaveLength(2);
    } finally {
      if (id) removeRunContainers(id);
      tools.cleanup();
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

function git(repoPath: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString("utf8")}`);
  return proc.stdout.toString("utf8").trim();
}

function fetchedBackRound(): { host: FixtureRepo; clonePath: string; roundStart: string; cleanup(): void } {
  const host = createFixtureRepo();
  const clonePath = mkdtempSync(path.join(tmpdir(), "crisol-fetch-back-clone-"));
  rmSync(clonePath, { recursive: true, force: true });
  cloneLocal(host.path, clonePath);
  checkoutNewBranch(clonePath, "work", git(host.path, ["rev-parse", "HEAD"]));
  git(clonePath, ["commit", "--quiet", "--allow-empty", "-m", "feat: first round"]);
  fetchBack(host.path, clonePath, "work", null);
  return {
    host,
    clonePath,
    roundStart: git(host.path, ["rev-parse", "refs/heads/work"]),
    cleanup() {
      rmSync(clonePath, { recursive: true, force: true });
      host.cleanup();
    },
  };
}

describe("Fetch-back after the agent rewrote its branch", () => {
  test("an amended branch replaces the host branch the round started from", () => {
    const round = fetchedBackRound();
    try {
      git(round.clonePath, ["commit", "--quiet", "--amend", "--allow-empty", "-m", "feat: first round, amended"]);
      const amended = git(round.clonePath, ["rev-parse", "refs/heads/work"]);

      fetchBack(round.host.path, round.clonePath, "work", round.roundStart);

      expect(git(round.host.path, ["rev-parse", "refs/heads/work"])).toBe(amended);
    } finally {
      round.cleanup();
    }
  });

  test("a host branch that moved since the round started is refused, naming both shas, and left where it is", () => {
    const round = fetchedBackRound();
    try {
      git(round.clonePath, ["commit", "--quiet", "--amend", "--allow-empty", "-m", "feat: first round, amended"]);
      const amended = git(round.clonePath, ["rev-parse", "refs/heads/work"]);
      const hostCommit = git(round.host.path, ["commit-tree", "work^{tree}", "-p", "work", "-m", "chore: a host-side commit"]);
      git(round.host.path, ["update-ref", "refs/heads/work", hostCommit]);

      let message = "";
      try {
        fetchBack(round.host.path, round.clonePath, "work", round.roundStart);
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain(round.roundStart);
      expect(message).toContain(hostCommit);
      expect(message).toContain(amended);
      expect(git(round.host.path, ["rev-parse", "refs/heads/work"])).toBe(hostCommit);
    } finally {
      round.cleanup();
    }
  });

  test("the command the refusal offers keeps the Run's work beside the host's", () => {
    const round = fetchedBackRound();
    try {
      git(round.clonePath, ["commit", "--quiet", "--amend", "--allow-empty", "-m", "feat: first round, amended"]);
      const amended = git(round.clonePath, ["rev-parse", "refs/heads/work"]);
      git(round.host.path, ["update-ref", "refs/heads/work", git(round.host.path, ["commit-tree", "work^{tree}", "-p", "work", "-m", "host"])]);

      let message = "";
      try {
        fetchBack(round.host.path, round.clonePath, "work", round.roundStart);
      } catch (error) {
        message = (error as Error).message;
      }
      const offered = message.match(/`(git -C [^`]+)`/)?.[1];
      expect(offered).toBeDefined();
      expect(Bun.spawnSync(offered!.split(" ")).exitCode).toBe(0);

      const holding = git(round.host.path, ["for-each-ref", "--format=%(refname:short)", "--points-at", amended, "refs/heads/"]);
      expect(holding).not.toBe("");
      expect(holding.split("\n")).not.toContain("work");
    } finally {
      round.cleanup();
    }
  });
});
