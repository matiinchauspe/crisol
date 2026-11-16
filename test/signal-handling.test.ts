import { describe, expect, test } from "bun:test";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { startCli, waitFor } from "./support/liveCli";
import {
  cloneSha,
  commitSubjects,
  readLog,
  readResult,
  refSha,
  removeRunContainers,
  runContainers,
  runIds,
} from "./support/runState";
import { wrapTools } from "./support/wrappedTools";

const FAKE_COMMIT = "feat: record the walking-skeleton run";

/** Real signals to a real `crisol` process: a `process.emit` in the test runner proves nothing about the OS. */
type Delivery = { signal: NodeJS.Signals; toGroup: boolean; like: string };

const DELIVERIES: Delivery[] = [
  { signal: "SIGINT", toGroup: true, like: "Ctrl+C in a terminal" },
  { signal: "SIGTERM", toGroup: false, like: "`kill <pid>`" },
  { signal: "SIGHUP", toGroup: true, like: "closing the terminal" },
];

function deliver(pid: number, delivery: Delivery): void {
  process.kill(delivery.toGroup ? -pid : pid, delivery.signal);
}

function mainSha(repoPath: string): string {
  return refSha(repoPath, "main")!;
}

describe("a signal during the Adapter phase", () => {
  for (const delivery of DELIVERIES) {
    test(`${delivery.signal} (${delivery.like}) tears the Sandbox down and leaves the branch in the host with the commits made so far`, async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      let id: string | undefined;
      try {
        const cli = startCli(["run", "x", "--gate", "sleep 60", "--json"], { cwd: repo.path, home: home.path });
        await waitFor(() => runIds(home.path).length === 1);
        id = runIds(home.path)[0]!;
        await waitFor(() => readLog(id!, home.path).includes("adapter reported completion"));

        deliver(cli.proc.pid, delivery);
        const done = await cli.finished();

        expect(done.exitCode).not.toBe(0);
        const branch = `crisol/${id}`;
        expect(refSha(repo.path, branch)).toBe(cloneSha(id, home.path, branch)!);
        expect(commitSubjects(repo.path, branch)).toContain(FAKE_COMMIT);
        expect(runContainers(id)).toEqual([]);
        expect(readLog(id, home.path)).toContain(`received ${delivery.signal}`);
        expect(readResult(id, home.path)).toMatchObject({
          status: "not-converged",
          reason: `interrupted: ${delivery.signal}`,
          fetchBack: true,
        });
      } finally {
        if (id) removeRunContainers(id);
        home.cleanup();
        repo.cleanup();
      }
    }, 60_000);
  }
});

describe("a signal before the Sandbox is up", () => {
  test("SIGTERM while `docker run` is still creating the Sandbox removes it and leaves the branch at its base", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const tools = wrapTools([{ tool: "docker", subcommand: "run", mode: { kind: "stall", seconds: 3 } }]);
    let id: string | undefined;
    try {
      const cli = startCli(["run", "x", "--json"], {
        cwd: repo.path,
        home: home.path,
        env: { PATH: `${tools.binDir}:${process.env.PATH}` },
      });
      await waitFor(() => tools.hits("docker", "run").length === 1);
      id = runIds(home.path)[0]!;

      process.kill(cli.proc.pid, "SIGTERM");
      const done = await cli.finished();

      expect(done.exitCode).not.toBe(0);
      expect(refSha(repo.path, `crisol/${id}`)).toBe(mainSha(repo.path));
      expect(runContainers(id)).toEqual([]);
      expect(readLog(id, home.path)).toContain("received SIGTERM");
      expect(readResult(id, home.path)).toMatchObject({ reason: "interrupted: SIGTERM", fetchBack: true });
    } finally {
      if (id) removeRunContainers(id);
      tools.cleanup();
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("Ctrl+C while the Clone is being made never starts a Sandbox and still leaves the branch at its base", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const tools = wrapTools([{ tool: "git", subcommand: "clone", mode: { kind: "stall", seconds: 3 } }]);
    let id: string | undefined;
    try {
      const cli = startCli(["run", "x", "--json"], {
        cwd: repo.path,
        home: home.path,
        env: { PATH: `${tools.binDir}:${process.env.PATH}` },
      });
      await waitFor(() => tools.hits("git", "clone").length === 1);
      id = runIds(home.path)[0]!;

      process.kill(-cli.proc.pid, "SIGINT");
      const done = await cli.finished();

      expect(done.exitCode).not.toBe(0);
      expect(refSha(repo.path, `crisol/${id}`)).toBe(mainSha(repo.path));
      expect(runContainers(id)).toEqual([]);
      const log = readLog(id, home.path);
      expect(log).toContain("received SIGINT");
      expect(log).not.toContain(" started from ");
      expect(readResult(id, home.path)).toMatchObject({ reason: "interrupted: SIGINT", fetchBack: true });
    } finally {
      if (id) removeRunContainers(id);
      tools.cleanup();
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("Ctrl+C again while the Run is already stopping", () => {
  test("a second Ctrl+C during teardown and a third during Fetch-back kill neither, and both are logged", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const tools = wrapTools([
      { tool: "docker", subcommand: "rm", mode: { kind: "stall", seconds: 2 } },
      { tool: "git", subcommand: "fetch", mode: { kind: "stall", seconds: 2 } },
    ]);
    let id: string | undefined;
    try {
      const cli = startCli(["run", "x", "--gate", "sleep 60", "--json"], {
        cwd: repo.path,
        home: home.path,
        env: { PATH: `${tools.binDir}:${process.env.PATH}` },
      });
      await waitFor(() => runIds(home.path).length === 1);
      id = runIds(home.path)[0]!;
      await waitFor(() => readLog(id!, home.path).includes("adapter reported completion"));

      process.kill(-cli.proc.pid, "SIGINT");
      await waitFor(() => tools.hits("docker", "rm").length === 1);
      process.kill(-cli.proc.pid, "SIGINT");
      await waitFor(() => tools.hits("git", "fetch").length === 1);
      process.kill(-cli.proc.pid, "SIGINT");
      const done = await cli.finished();

      expect(done.exitCode).not.toBe(0);
      const branch = `crisol/${id}`;
      expect(refSha(repo.path, branch)).toBe(cloneSha(id, home.path, branch)!);
      expect(runContainers(id)).toEqual([]);
      const log = readLog(id, home.path);
      expect(log.split("\n").filter((line) => line.includes("received SIGINT"))).toHaveLength(3);
      // Three legitimate removals, never a retry: the Sandbox's own `docker rm -f`, the
      // Allowlist proxy's own `docker rm -f`, and `docker network rm` for the wall's network —
      // the wrapper matches "rm" as a bare argv word, so `network rm` counts here too. A retry
      // would add a FOURTH hit, which this still catches.
      expect(tools.hits("docker", "rm")).toHaveLength(3);
      expect(tools.hits("git", "fetch")).toHaveLength(1);
      expect(log).not.toContain("FAILED to stop");
    } finally {
      if (id) removeRunContainers(id);
      tools.cleanup();
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});
