import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runLogPath, runRepoPath } from "../src/paths";
import type { RunResult } from "../src/run";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

function git(repoPath: string, ...args: string[]): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString("utf8").trim() };
}

function logTime(log: string, marker: string): number {
  const line = log.split("\n").find((entry) => entry.includes(marker));
  if (!line) throw new Error(`no "${marker}" line in log:\n${log}`);
  return Date.parse(line.slice(1, line.indexOf("]")));
}

describe('crisol run "a" "b" "c" — independent Runs from one base', () => {
  test("leaves three branches cut from the same base, none merged, each from its own container and Clone", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const baseSha = git(repo.path, "rev-parse", "HEAD").stdout;

      // The Gate keeps each Sandbox alive long enough that the three Runs provably overlap.
      const cli = await runCli(["run", "a", "b", "c", "--gate", "sleep 2", "--json", "--adapter", "fake"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(cli.stderr).toBe("");
      expect(cli.exitCode).toBe(0);

      const results = cli.stdout.trim().split("\n").map((line) => JSON.parse(line) as RunResult);
      expect(results).toHaveLength(3);
      expect(results.every((result) => result.status === "verified")).toBe(true);
      const bases = new Set(results.map((result) => result.base));
      expect(bases.size).toBe(1);
      const [baseRef, reportedSha] = [...bases][0]!.split("@");
      expect(baseRef).toBe("main");
      expect(baseSha.startsWith(reportedSha!)).toBe(true);

      const branches = results.map((result) => result.branch);
      expect(new Set(branches).size).toBe(3);
      // The fake Adapter's commits are byte-identical within one second, so two branches may
      // share a sha; "none merged" is asserted as one non-merge commit straight on the base.
      for (const branch of branches) {
        expect(git(repo.path, "rev-parse", `${branch}~1`).stdout).toBe(baseSha);
        expect(git(repo.path, "rev-list", "--count", `${baseSha}..${branch}`).stdout).toBe("1");
        expect(git(repo.path, "rev-list", "--merges", `${baseSha}..${branch}`).stdout).toBe("");
      }
      expect(git(repo.path, "rev-parse", "main").stdout).toBe(baseSha);

      const runs = results.map((result) => {
        const log = readFileSync(runLogPath(result.run, home.path), "utf8");
        const started = /sandbox (\S+) started from \S+, mounts=(.*)$/m.exec(log)!;
        return {
          clone: runRepoPath(result.run, home.path),
          container: started[1]!,
          mounts: started[2]!.split(","),
          startedAt: logTime(log, "sandbox "),
          stoppedAt: logTime(log, " stopped"),
        };
      });
      expect(new Set(runs.map((entry) => entry.container)).size).toBe(3);
      expect(new Set(runs.map((entry) => entry.clone)).size).toBe(3);
      for (const entry of runs) {
        // The Clone is the only writable mount; no other Run's path reaches this Sandbox.
        expect(entry.mounts).toEqual([`${entry.clone}:${entry.clone}`]);
      }
      for (const entry of runs) {
        for (const other of runs.filter((candidate) => candidate !== entry)) {
          expect(entry.startedAt).toBeLessThan(other.stoppedAt);
        }
      }
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);

  test("more Tasks than Slots queue inside one process and all finish", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "config"), "max_parallel = 1\n");
      const cli = await runCli(["run", "a", "b", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      expect(cli.exitCode).toBe(0);
      const results = cli.stdout.trim().split("\n").map((line) => JSON.parse(line) as RunResult);
      expect(results.map((result) => result.status)).toEqual(["unverified", "unverified"]);
      expect(cli.stderr).toContain("Waiting for a free Slot (max_parallel = 1)");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);

  test("--name with more than one Task is a usage error, before anything runs", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const cli = await runCli(["run", "a", "b", "--name", "feat/x"], { cwd: repo.path, home: home.path });
      expect(cli.exitCode).not.toBe(0);
      expect(cli.stderr).toContain("--name");
      expect(git(repo.path, "branch", "--list", "feat/x").stdout).toBe("");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});
