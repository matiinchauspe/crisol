import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PreStartDeclaration } from "../src/adapter";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code";
import { runLogPath, runRepoPath, runSessionIdPath } from "../src/paths";
import { runFanOut } from "../src/run";
import type { RunResult } from "../src/run";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

function git(repoPath: string, ...args: string[]): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString("utf8").trim() };
}

/** Commits the session id each turn ran in, so the branch shows whose session a resume took. */
const FAKE_CLAUDE = `#!/bin/sh
cat > /dev/null
if [ "$2" = "--resume" ]; then
  echo "$3" > RESUMED_SESSION
  echo ok > GATE_TARGET.txt
  git add RESUMED_SESSION GATE_TARGET.txt
  git commit --quiet -m "fix: make the Gate green"
  printf '{"session_id":"%s","result":"resumed"}' "$3"
else
  session=$(cat /proc/sys/kernel/random/uuid)
  echo "$session" > LAUNCHED_SESSION
  echo oops > GATE_TARGET.txt
  git add LAUNCHED_SESSION GATE_TARGET.txt
  git commit --quiet -m "feat: attempt (Gate still red)"
  printf '{"session_id":"%s","result":"launched"}' "$session"
fi
`;

/** The real Adapter's session handling on the Project layer, so no Claude Code is installed. */
class ScriptedClaudeCodeAdapter extends ClaudeCodeAdapter {
  override declarePreStart(): PreStartDeclaration {
    return { envNames: [], mounts: [] };
  }
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

  test("each Run resumes its own agent session on a red Gate and keeps its own session id", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "fake-claude"), FAKE_CLAUDE);
      chmodSync(path.join(repo.path, "fake-claude"), 0o755);
      git(repo.path, "add", "fake-claude");
      git(repo.path, "commit", "--quiet", "-m", "test: add the fake agent CLI");

      const settled = await runFanOut(["a", "b", "c"], {
        cwd: repo.path,
        home: home.path,
        // The sleep holds every Run's first red Gate until all three have launched, so a session
        // shared between them would be overwritten before any Run resumes.
        gates: ["sleep 3 && grep -qx ok GATE_TARGET.txt"],
        buildAdapter: () => new ScriptedClaudeCodeAdapter({ binary: "./fake-claude", hostVersion: () => "0.0.0" }),
      });

      const results = settled.map((outcome) => {
        if (outcome.status === "rejected") throw outcome.reason;
        return outcome.value;
      });
      expect(results.map((result) => [result.status, result.iterations])).toEqual([
        ["verified", 2],
        ["verified", 2],
        ["verified", 2],
      ]);
      const launched = results.map((result) => {
        const session = git(repo.path, "show", `${result.branch}:LAUNCHED_SESSION`).stdout;
        expect(git(repo.path, "show", `${result.branch}:RESUMED_SESSION`).stdout).toBe(session);
        expect(readFileSync(runSessionIdPath(result.run, home.path), "utf8")).toBe(session);
        return session;
      });
      expect(new Set(launched).size).toBe(3);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 180_000);

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
