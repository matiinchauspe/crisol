import { describe, expect, test } from "bun:test";
import { runRepoPath } from "../src/paths";
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
} from "./support/runState";

describe("crisol recover", () => {
  test("after SIGKILL mid-Run the branch is missing; recover brings it to the host at the Clone's commit", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    let id: string | undefined;
    try {
      const cli = startCli(["run", "x", "--gate", "sleep 120", "--json"], { cwd: repo.path, home: home.path });
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
      const cli = startCli(["run", "x", "--gate", "sleep 60", "--json"], { cwd: repo.path, home: home.path });
      await waitFor(() => runIds(home.path).length === 1);
      id = runIds(home.path)[0]!;
      await waitFor(() => readLog(id!, home.path).includes("adapter reported completion"));

      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });

      expect(recovered.exitCode).toBe(0);
      expect(recovered.stdout).toContain(`Run ${id}: live`);
      expect(refSha(repo.path, `crisol/${id}`)).toBeUndefined();
      expect(runContainers(id)).toHaveLength(1);
      expect(readLog(id, home.path)).not.toContain("recover:");

      process.kill(-cli.proc.pid, "SIGINT");
      await cli.finished();
    } finally {
      if (id) removeRunContainers(id);
      home.cleanup();
      repo.cleanup();
    }
  }, 90_000);

  test("fast-forwards a host branch that is behind the Clone", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json"], { cwd: repo.path, home: home.path });
      const result = JSON.parse(done.stdout) as RunResult;
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

  test("says so when there is nothing to recover", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      await runCli(["run", "x", "--json"], { cwd: repo.path, home: home.path });
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
