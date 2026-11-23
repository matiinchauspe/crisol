import { describe, expect, test } from "bun:test";
import type { Adapter } from "../src/adapter";
import { run } from "../src/run";
import type { RunResult } from "../src/run";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { startCli, waitFor } from "./support/liveCli";
import { cloneSha, onlyRunId, readLog, readResult, refSha, removeRunContainers, runContainers } from "./support/runState";
import { wrapTools } from "./support/wrappedTools";

describe("result.json records whether Fetch-back completed", () => {
  test("a Run that converges records fetchBack: true, in result.json and on stdout", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json"], { cwd: repo.path, home: home.path });

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
      const done = await runCli(["run", "x", "--gate", "false", "--max-iterations", "1", "--json"], {
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
      const cli = startCli(["run", "x", "--json"], {
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
      const done = await runCli(["run", "x", "--json"], {
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
      const done = await runCli(["run", "x", "--json"], {
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
