import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Adapter, AdapterContext } from "../src/adapter";
import { DEFAULT_SCRIPT, FakeAdapter, GATE_FAILING_SCRIPT } from "../src/adapters/fake";
import type { FakeSession } from "../src/adapters/fake";
import { discoverGitRoot } from "../src/git";
import { runDir, runLockPath, runRepoPath, runResultPath } from "../src/paths";
import { run } from "../src/run";
import type { RunResult } from "../src/run";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { cloneSha, commitSubjects, readLog, readResult, refSha, runIds } from "./support/runState";

const STORE = "/crisol-fake-sessions";

const REVIEW_SCRIPT: readonly string[] = [
  "echo 'review applied' > REVIEW.md",
  "git add REVIEW.md",
  "git commit --quiet -m 'fix: apply the review'",
];

function fakeAgent(options: { launch?: string; continue?: string; continueScript?: readonly string[] } = {}): FakeAdapter {
  const session: FakeSession = { store: STORE, continueScript: options.continueScript ?? REVIEW_SCRIPT };
  return new FakeAdapter(DEFAULT_SCRIPT, undefined, undefined, { launch: options.launch, continue: options.continue }, session);
}

/** Records every session a Continuation resumes and the request it sends, without changing what the Adapter does. */
function recordingContinuations(inner: Adapter): { adapter: Adapter; calls: { sessionId: string; request: string }[] } {
  const calls: { sessionId: string; request: string }[] = [];
  const adapter: Adapter = {
    sessionStore: inner.sessionStore,
    declarePreStart: (projectImage: string) => inner.declarePreStart(projectImage),
    launch: (ctx: AdapterContext) => inner.launch(ctx),
    reportCompletion: (ctx: AdapterContext) => inner.reportCompletion(ctx),
    resumeWithFeedback: (ctx: AdapterContext, feedback: string) => inner.resumeWithFeedback(ctx, feedback),
    sessionId: () => inner.sessionId?.(),
    async continueSession(ctx: AdapterContext, sessionId: string, request: string) {
      calls.push({ sessionId, request });
      return inner.continueSession!(ctx, sessionId, request);
    },
  };
  return { adapter, calls };
}

/** Runs `beforeTurn` right before the Continuation's first turn, once pre-flight has already passed. */
function hostMovesDuringContinuation(inner: Adapter, beforeTurn: () => void): Adapter {
  return {
    sessionStore: inner.sessionStore,
    declarePreStart: (projectImage: string) => inner.declarePreStart(projectImage),
    launch: (ctx: AdapterContext) => inner.launch(ctx),
    reportCompletion: (ctx: AdapterContext) => inner.reportCompletion(ctx),
    resumeWithFeedback: (ctx: AdapterContext, feedback: string) => inner.resumeWithFeedback(ctx, feedback),
    sessionId: () => inner.sessionId?.(),
    async continueSession(ctx: AdapterContext, sessionId: string, request: string) {
      beforeTurn();
      return inner.continueSession!(ctx, sessionId, request);
    },
  };
}

function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  return Bun.spawnSync(["git", "-C", repoPath, "merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0;
}

function git(repoPath: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString("utf8")}`);
  return proc.stdout.toString("utf8").trim();
}

/** A Run that ended before it ever held a Slot: its lock and Run result name `branch`, but it made no Clone. */
function fakeUnstartedRun(home: string, id: string, host: string, branch: string): void {
  mkdirSync(runDir(id, home), { recursive: true });
  writeFileSync(runLockPath(id, home), JSON.stringify({ host, branch }));
  const result: RunResult = {
    run: id,
    branch,
    base: "main@0000000000000000000000000000000000000000",
    status: "not-converged",
    reason: "error: Docker engine is not reachable",
    iterations: 0,
    gates: [],
    network: "allowlist",
    blocked: [],
    warnings: [],
    fetchBack: false,
    finishedAt: Date.now(),
  };
  writeFileSync(runResultPath(id, home), JSON.stringify(result, null, 2));
}

describe("ticket 21: a Continuation takes a Run up again by its branch", () => {
  test(
    "resumes the Run's own session over the same Clone, advances its branch fast-forward and rewrites its Run result",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const firstAdapter = fakeAgent({ launch: "round one" });
        const first = await run({
          task: "write the file",
          cwd: repo.path,
          home: home.path,
          name: "feature/review-me",
          gates: ["test -f CRISOL_RUN.md"],
          adapter: firstAdapter,
        });
        expect(first.status).toBe("verified");
        const firstSession = firstAdapter.sessionId();
        expect(firstSession).toBeDefined();
        const firstTip = refSha(repo.path, first.branch)!;

        const { adapter, calls } = recordingContinuations(fakeAgent({ continue: "round two" }));
        const continued = await run({
          task: "rename the file, please",
          cwd: repo.path,
          home: home.path,
          continue: "feature/review-me",
          adapter,
        });

        expect(runIds(home.path)).toEqual([first.run]);
        expect(continued).toMatchObject({
          run: first.run,
          branch: first.branch,
          base: first.base,
          status: "verified",
          finalMessage: "round two",
          fetchBack: true,
        });
        // No --gate on the Continuation: it runs the Gates its Run was given.
        expect(continued.gates).toEqual([{ cmd: "test -f CRISOL_RUN.md", ok: true }]);
        expect(continued.finishedAt).toBeGreaterThan(first.finishedAt);
        expect(readResult(first.run, home.path)).toEqual(continued);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.sessionId).toBe(firstSession!);
        expect(calls[0]!.request).toContain("rename the file, please");
        expect(existsSync(path.join(runDir(first.run, home.path), "sessions", firstSession!))).toBe(true);

        const secondTip = refSha(repo.path, first.branch)!;
        expect(secondTip).not.toBe(firstTip);
        expect(isAncestor(repo.path, firstTip, secondTip)).toBe(true);
        expect(commitSubjects(repo.path, first.branch)).toContain("fix: apply the review");

        const log = readLog(first.run, home.path);
        const clone = path.join(runDir(first.run, home.path), "repo");
        const sandboxes = log.split("\n").filter((line) => / started from \S+, mounts=/.test(line));
        expect(sandboxes).toHaveLength(2);
        for (const line of sandboxes) expect(line).toContain(`${clone}:${clone}`);
        expect(log.match(/result written:/g)).toHaveLength(2);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    120_000,
  );

  test(
    "a Continuation honours the Stop line: parked over a failing Gate, with no Gate run",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const first = await run({
          task: "write the file",
          cwd: repo.path,
          home: home.path,
          adapter: fakeAgent(),
        });

        const continued = await run({
          task: "make it pass",
          cwd: repo.path,
          home: home.path,
          continue: first.branch,
          gates: ["false"],
          adapter: fakeAgent({ continue: "Which name wins?\nCRISOL-STOP: parked", continueScript: GATE_FAILING_SCRIPT }),
        });

        expect(continued.status).toBe("parked");
        expect(continued.gates).toEqual([]);
        expect(continued.iterations).toBe(1);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    120_000,
  );

  test(
    "a branch no Run owns is refused before any Sandbox starts, naming the branch",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        await expect(
          run({ task: "more", cwd: repo.path, home: home.path, continue: "nobody/owns-this", adapter: fakeAgent() }),
        ).rejects.toThrow(/nobody\/owns-this/);
        expect(runIds(home.path)).toEqual([]);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "a branch two Runs claim is refused before any Sandbox starts, naming the branch and both Runs",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const first = await run({ task: "one", cwd: repo.path, home: home.path, name: "shared", adapter: fakeAgent() });
        git(repo.path, ["branch", "-D", "shared"]);
        const second = await run({ task: "two", cwd: repo.path, home: home.path, name: "shared", adapter: fakeAgent() });
        const logsBefore = [readLog(first.run, home.path), readLog(second.run, home.path)];

        const refusal = run({ task: "more", cwd: repo.path, home: home.path, continue: "shared", adapter: fakeAgent() });
        await expect(refusal).rejects.toThrow(/"shared"/);
        await expect(refusal).rejects.toThrow(new RegExp(`${first.run}.*${second.run}|${second.run}.*${first.run}`));
        expect([readLog(first.run, home.path), readLog(second.run, home.path)]).toEqual(logsBefore);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    120_000,
  );

  test(
    "a host branch that moves during the round, after pre-flight already passed, is still refused at Fetch-back, never forced",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const first = await run({ task: "one", cwd: repo.path, home: home.path, name: "race", adapter: fakeAgent() });

        let hostCommit = "";
        const adapter = hostMovesDuringContinuation(fakeAgent({ continue: "round two" }), () => {
          const tree = git(repo.path, ["rev-parse", "race^{tree}"]);
          hostCommit = git(repo.path, ["commit-tree", tree, "-p", "race", "-m", "chore: a host-side commit mid-round"]);
          git(repo.path, ["update-ref", "refs/heads/race", hostCommit]);
        });

        let failure: unknown;
        try {
          await run({ task: "more", cwd: repo.path, home: home.path, continue: "race", adapter });
        } catch (error) {
          failure = error;
        }

        expect(String((failure as Error | undefined)?.message)).toMatch(/non-fast-forward|rejected/);
        expect(refSha(repo.path, "race")).toBe(hostCommit);
        const result = (failure as { result?: RunResult }).result;
        expect(result).toMatchObject({ run: first.run, fetchBack: false });
        expect(readResult(first.run, home.path)?.fetchBack).toBe(false);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    120_000,
  );

  test(
    "crisol run --continue <branch> continues a Run from the CLI and prints its rewritten Run result",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const started = await runCli(["run", "say hello", "--json", "--name", "cli/continued"], {
          cwd: repo.path,
          home: home.path,
        });
        expect(started.exitCode).toBe(0);
        const first = JSON.parse(started.stdout) as RunResult;

        const continued = await runCli(["run", "--continue", "cli/continued", "say it again", "--json"], {
          cwd: repo.path,
          home: home.path,
        });

        expect(continued.stderr).toBe("");
        expect(continued.exitCode).toBe(0);
        const payload = JSON.parse(continued.stdout) as RunResult;
        expect(payload).toMatchObject({ run: first.run, branch: "cli/continued", fetchBack: true });
        expect(commitSubjects(repo.path, "cli/continued")).toHaveLength(3);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    120_000,
  );

  for (const [flag, extra] of [
    ["--name", ["--name", "other"]],
    ["--base", ["--base", "main"]],
    ["--detach", ["--detach"]],
  ] as const) {
    test(`--continue refuses ${flag}: a Continuation keeps its Run's branch and base`, async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await runCli(["run", "--continue", "some/branch", "more", ...extra], {
          cwd: repo.path,
          home: home.path,
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.split("\n")[0]).toMatch(new RegExp(`^--continue .*cannot be combined with ${flag}`));
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    });
  }
});

describe("only a Run with a Clone claims its branch", () => {
  test(
    "after its Clone is gc'd and its name reused, --continue finds only the live Run",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const first = await run({ task: "one", cwd: repo.path, home: home.path, name: "reused", adapter: fakeAgent() });
        rmSync(runRepoPath(first.run, home.path), { recursive: true, force: true }); // what `crisol gc` leaves behind
        git(repo.path, ["branch", "-D", "reused"]);

        const second = await run({ task: "two", cwd: repo.path, home: home.path, name: "reused", adapter: fakeAgent() });

        const continued = await run({
          task: "three",
          cwd: repo.path,
          home: home.path,
          continue: "reused",
          adapter: fakeAgent({ continue: "round two" }),
        });

        expect(continued.run).toBe(second.run);
        expect(runIds(home.path).sort()).toEqual([first.run, second.run].sort());
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    180_000,
  );

  test(
    "a Run whose Clone crisol gc collected is still refused by naming gc as the true cause",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const first = await run({ task: "one", cwd: repo.path, home: home.path, name: "collected", adapter: fakeAgent() });
        rmSync(runRepoPath(first.run, home.path), { recursive: true, force: true });

        let failure: unknown;
        try {
          await run({ task: "more", cwd: repo.path, home: home.path, continue: "collected", adapter: fakeAgent() });
        } catch (error) {
          failure = error;
        }

        const message = String((failure as Error | undefined)?.message);
        expect(message).toContain(`Run ${first.run} names branch "collected" in its Run result but has no Clone`);
        expect(message).toContain("`crisol gc` collected it");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "a Run that never held a Slot is refused by naming that, never gc, when its branch is continued",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        // `discoverGitRoot` resolves symlinks (macOS's /var -> /private/var), same as a real Run would.
        fakeUnstartedRun(home.path, "ghost1234", discoverGitRoot(repo.path)!, "ghost");

        let failure: unknown;
        try {
          await run({ task: "more", cwd: repo.path, home: home.path, continue: "ghost", adapter: fakeAgent() });
        } catch (error) {
          failure = error;
        }

        const message = String((failure as Error | undefined)?.message);
        expect(message).toContain(`Run ghost1234 names branch "ghost" in its Run result but has no Clone`);
        expect(message).toContain("ended before it ever held a Slot");
        expect(message).not.toContain("crisol gc");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );
});

describe("a Continuation checks its branch is fetchable before any Sandbox starts", () => {
  test(
    "a branch checked out in a worktree of the host repo is refused, naming the worktree",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      const worktreePath = mkdtempSync(path.join(tmpdir(), "crisol-review-worktree-"));
      try {
        const first = await run({ task: "one", cwd: repo.path, home: home.path, name: "reviewed", adapter: fakeAgent() });
        git(repo.path, ["worktree", "add", worktreePath, "reviewed"]);

        await expect(
          run({ task: "more", cwd: repo.path, home: home.path, continue: "reviewed", adapter: fakeAgent() }),
        ).rejects.toThrow(worktreePath);

        expect(runIds(home.path)).toEqual([first.run]);
        expect(readResult(first.run, home.path)).toEqual(first);
      } finally {
        git(repo.path, ["worktree", "remove", "--force", worktreePath]);
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "a branch whose tip differs between the host and its Run's Clone is refused, naming both tips",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const first = await run({ task: "one", cwd: repo.path, home: home.path, name: "diverged", adapter: fakeAgent() });
        const cloneTip = refSha(repo.path, "diverged")!;
        // A commit lands on the host branch meanwhile, so its tip no longer matches the Run's Clone.
        const tree = git(repo.path, ["rev-parse", "diverged^{tree}"]);
        const hostCommit = git(repo.path, ["commit-tree", tree, "-p", "diverged", "-m", "chore: a host-side commit"]);
        git(repo.path, ["update-ref", "refs/heads/diverged", hostCommit]);

        await expect(
          run({ task: "more", cwd: repo.path, home: home.path, continue: "diverged", adapter: fakeAgent() }),
        ).rejects.toThrow(new RegExp(`${hostCommit}.*${cloneTip}|${cloneTip}.*${hostCommit}`));

        expect(refSha(repo.path, "diverged")).toBe(hostCommit);
        expect(cloneSha(first.run, home.path, "diverged")).toBe(cloneTip);
        expect(runIds(home.path)).toEqual([first.run]);
        expect(readResult(first.run, home.path)).toEqual(first);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );
});
