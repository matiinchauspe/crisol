import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Adapter, AdapterContext } from "../src/adapter";
import { DEFAULT_SCRIPT, FakeAdapter, GATE_FAILING_SCRIPT } from "../src/adapters/fake";
import type { FakeSession } from "../src/adapters/fake";
import { checkoutNewBranch, cloneLocal, discoverGitRoot, shortSha } from "../src/git";
import { runDir, runLockPath, runPidPath, runRepoPath, runResultPath } from "../src/paths";
import { run } from "../src/run";
import type { RunResult } from "../src/run";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { startCli, waitFor } from "./support/liveCli";
import { cloneSha, commitSubjects, readLog, readResult, refSha, runIds } from "./support/runState";

const HOLD_RUN_LOCK = path.join(import.meta.dir, "support", "holdRunLock.ts");
const HOLD_SLOT = path.join(import.meta.dir, "support", "holdSlot.ts");

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
    name: inner.name,
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

/** Wraps an Adapter under a different identity, so a test can exercise Adapter-name matching without a second real Adapter. */
function namedAdapter(name: string, inner: Adapter): Adapter {
  return {
    name,
    sessionStore: inner.sessionStore,
    declarePreStart: (projectImage: string) => inner.declarePreStart(projectImage),
    launch: (ctx: AdapterContext) => inner.launch(ctx),
    reportCompletion: (ctx: AdapterContext) => inner.reportCompletion(ctx),
    resumeWithFeedback: (ctx: AdapterContext, feedback: string) => inner.resumeWithFeedback(ctx, feedback),
    sessionId: () => inner.sessionId?.(),
    continueSession: inner.continueSession
      ? (ctx: AdapterContext, sessionId: string, request: string) => inner.continueSession!(ctx, sessionId, request)
      : undefined,
  };
}

function namelessAdapter(inner: Adapter, options: { continues: boolean }): Adapter {
  return {
    sessionStore: inner.sessionStore,
    declarePreStart: (projectImage: string) => inner.declarePreStart(projectImage),
    launch: (ctx: AdapterContext) => inner.launch(ctx),
    reportCompletion: (ctx: AdapterContext) => inner.reportCompletion(ctx),
    resumeWithFeedback: (ctx: AdapterContext, feedback: string) => inner.resumeWithFeedback(ctx, feedback),
    sessionId: () => inner.sessionId?.(),
    continueSession: options.continues
      ? (ctx: AdapterContext, sessionId: string, request: string) => inner.continueSession!(ctx, sessionId, request)
      : undefined,
  };
}

/** Runs `beforeTurn` right before the Continuation's first turn, once pre-flight has already passed. */
function hostMovesDuringContinuation(inner: Adapter, beforeTurn: () => void): Adapter {
  return {
    name: inner.name,
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
        expect(first.adapter).toBe("fake");
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
          adapter: "fake",
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
        const started = await runCli(["run", "say hello", "--json", "--name", "cli/continued", "--adapter", "fake"], {
          cwd: repo.path,
          home: home.path,
        });
        expect(started.exitCode).toBe(0);
        const first = JSON.parse(started.stdout) as RunResult;

        const continued = await runCli(["run", "--continue", "cli/continued", "say it again", "--json"], {
          cwd: repo.path,
          home: home.path,
        });

        expect(continued.stderr).toBe(`Continuing Run ${first.run} with Adapter fake (recorded by the Run).\n`);
        expect(continued.exitCode).toBe(0);
        const payload = JSON.parse(continued.stdout) as RunResult;
        expect(payload).toMatchObject({ run: first.run, branch: "cli/continued", adapter: "fake", fetchBack: true });
        expect(commitSubjects(repo.path, "cli/continued")).toHaveLength(3);

        // Inheriting and an explicit `--adapter fake` must build the Adapter from the same table, so
        // their finalMessages match.
        const explicit = await runCli(
          ["run", "--continue", "cli/continued", "say it once more", "--adapter", "fake", "--json"],
          { cwd: repo.path, home: home.path },
        );
        expect(explicit.exitCode).toBe(0);
        const explicitPayload = JSON.parse(explicit.stdout) as RunResult;
        expect(payload.finalMessage).toBeDefined();
        expect(explicitPayload.finalMessage).toBe(payload.finalMessage);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    180_000,
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

describe("status and recover read a Continuation's OWN round, never an earlier one's result", () => {
  test(
    "a held lock with an earlier round's result shows running, not that round's outcome",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      const id = "cont0001";
      const branch = `crisol/${id}`;
      let holder: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
      try {
        const host = discoverGitRoot(repo.path)!;
        mkdirSync(runDir(id, home.path), { recursive: true });
        writeFileSync(runLockPath(id, home.path), JSON.stringify({ host, branch }));
        const firstRound: RunResult = {
          run: id,
          branch,
          base: `main@${shortSha(repo.path, "HEAD")}`,
          status: "verified",
          iterations: 1,
          gates: [],
          network: "allowlist",
          blocked: [],
          warnings: [],
          fetchBack: true,
          finishedAt: Date.now(),
          finalMessage: "round one's own last word",
        };
        writeFileSync(runResultPath(id, home.path), JSON.stringify(firstRound, null, 2));
        mkdirSync(runRepoPath(id, home.path)); // the Clone a Continuation's earlier round leaves behind

        // A Continuation's own reservation re-locks with the same content, only a newer mtime —
        // what tells its round apart from the one that already wrote the result above.
        await Bun.sleep(10);
        writeFileSync(runLockPath(id, home.path), JSON.stringify({ host, branch }));
        holder = Bun.spawn(["bun", "run", HOLD_RUN_LOCK, runLockPath(id, home.path)], { stdout: "pipe" });
        const reader = holder.stdout.getReader();
        const { value } = await reader.read();
        expect(new TextDecoder().decode(value)).toContain("held");
        writeFileSync(runPidPath(id, home.path), String(holder.pid));

        const status = await runCli(["status"], { cwd: repo.path, home: home.path });

        const line = status.stdout.split("\n").find((entry) => entry.startsWith(id));
        expect(line).toContain("running");
        expect(line).not.toContain("verified");
      } finally {
        holder?.kill("SIGKILL");
        await holder?.exited;
        home.cleanup();
        repo.cleanup();
      }
    },
    30_000,
  );

  test(
    "a Continuation killed mid-round shows dead, and recover marks it interrupted with no stale finalMessage",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      const id = "cont0002";
      const branch = `crisol/${id}`;
      try {
        const hostHead = shortSha(repo.path, "HEAD");
        const host = discoverGitRoot(repo.path)!;
        mkdirSync(runDir(id, home.path), { recursive: true });
        writeFileSync(runLockPath(id, home.path), JSON.stringify({ host, branch }));

        const clonePath = runRepoPath(id, home.path);
        cloneLocal(repo.path, clonePath);
        checkoutNewBranch(clonePath, branch, hostHead);
        git(repo.path, ["branch", branch, hostHead]); // round one's own Fetch-back, already in the host

        const firstRound: RunResult = {
          run: id,
          branch,
          base: `main@${hostHead}`,
          status: "verified",
          iterations: 1,
          gates: [],
          network: "allowlist",
          blocked: [],
          warnings: [],
          fetchBack: true,
          finishedAt: Date.now(),
          finalMessage: "round one's own last word",
        };
        writeFileSync(runResultPath(id, home.path), JSON.stringify(firstRound, null, 2));

        const beforeKill = await runCli(["status"], { cwd: repo.path, home: home.path });
        expect(beforeKill.stdout).toContain("verified");

        await Bun.sleep(10);
        writeFileSync(runLockPath(id, home.path), JSON.stringify({ host, branch }));
        git(clonePath, ["commit", "--quiet", "--allow-empty", "-m", "feat: progress the dead round made"]);

        const whileDead = await runCli(["status"], { cwd: repo.path, home: home.path });
        const deadLine = whileDead.stdout.split("\n").find((entry) => entry.startsWith(id));
        expect(deadLine).toContain("dead");
        expect(deadLine).not.toContain("verified");

        const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });
        expect(recovered.exitCode).toBe(0);
        expect(recovered.stdout).toContain(`Run ${id}: recovered ${branch}`);

        const settled = readResult(id, home.path)!;
        expect(settled.status).toBe("not-converged");
        expect(settled.reason).toContain("interrupted");
        expect(settled.finalMessage).toBeUndefined();
        expect(settled.fetchBack).toBe(true);
        expect(refSha(repo.path, branch)).toBe(cloneSha(id, home.path, branch));

        const afterRecover = await runCli(["status"], { cwd: repo.path, home: home.path });
        const finishedLine = afterRecover.stdout.split("\n").find((entry) => entry.startsWith(id));
        expect(finishedLine).toContain("not-converged");
        expect(finishedLine).toContain("interrupted");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    30_000,
  );
});

describe("a Continuation refuses an Adapter mismatch", () => {
  test(
    "an Adapter other than the recorded one is refused before any Sandbox starts, naming both",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const first = await run({ task: "one", cwd: repo.path, home: home.path, name: "mismatched", adapter: fakeAgent() });
        expect(first.adapter).toBe("fake");

        await expect(
          run({
            task: "more",
            cwd: repo.path,
            home: home.path,
            continue: "mismatched",
            adapter: namedAdapter("claude-code", fakeAgent({ continue: "must never run" })),
          }),
        ).rejects.toThrow(/Adapter "fake", not "claude-code"/);

        expect(runIds(home.path)).toEqual([first.run]);
        expect(readResult(first.run, home.path)).toEqual(first);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "no --adapter inherits the recorded one, naming it, rather than running the fake Adapter over another's branch",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const first = await run({
          task: "one",
          cwd: repo.path,
          home: home.path,
          name: "inherited",
          adapter: namedAdapter("other-agent", fakeAgent({ launch: "round one" })),
        });
        expect(first.adapter).toBe("other-agent");

        let inherited: { adapterName: string; runId: string } | undefined;
        const continued = await run({
          task: "more",
          cwd: repo.path,
          home: home.path,
          continue: "inherited",
          adapterByName: (name) => namedAdapter(name, fakeAgent({ continue: "round two" })),
          onAdapterInherited: (adapterName, runId) => {
            inherited = { adapterName, runId };
          },
        });

        expect(inherited).toEqual({ adapterName: "other-agent", runId: first.run });
        expect(continued.adapter).toBe("other-agent");
        expect(continued.finalMessage).toBe("round two");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "no --adapter on a Run from before Crisol recorded one is refused, asking for --adapter",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const first = await run({ task: "one", cwd: repo.path, home: home.path, name: "unrecorded", adapter: fakeAgent() });
        const beforeRecording = readResult(first.run, home.path)!;
        delete beforeRecording.adapter;
        writeFileSync(runResultPath(first.run, home.path), JSON.stringify(beforeRecording, null, 2));

        await expect(
          run({ task: "more", cwd: repo.path, home: home.path, continue: "unrecorded" }),
        ).rejects.toThrow(/kept no record of which Adapter made it/);

        expect(runIds(home.path)).toEqual([first.run]);
        expect(readResult(first.run, home.path)).toEqual(beforeRecording);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );
});

describe("a nameless Adapter never yields a false refusal", () => {
  test("one that implements continueSession is refused before any Run starts, since its Runs could never be inherited", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      await expect(
        run({ task: "one", cwd: repo.path, home: home.path, adapter: namelessAdapter(fakeAgent(), { continues: true }) }),
      ).rejects.toThrow(/implements continueSession but has no name/);
      expect(runIds(home.path)).toEqual([]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test(
    "continuing a named Run, a nameless Adapter is refused by what it lacks, never as \"undefined\"",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const first = await run({ task: "one", cwd: repo.path, home: home.path, name: "named", adapter: fakeAgent() });
        expect(first.adapter).toBe("fake");

        const continuing = run({
          task: "more",
          cwd: repo.path,
          home: home.path,
          continue: "named",
          adapter: namelessAdapter(fakeAgent({ continue: "must never run" }), { continues: true }),
        });
        await expect(continuing).rejects.toThrow(/implements continueSession but has no name/);
        await expect(continuing).rejects.not.toThrow(/undefined/);

        const stopping = run({
          task: "more",
          cwd: repo.path,
          home: home.path,
          continue: "named",
          adapter: namelessAdapter(fakeAgent(), { continues: false }),
        });
        await expect(stopping).rejects.toThrow(/cannot continue a session/);
        await expect(stopping).rejects.not.toThrow(/undefined/);

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

describe("ticket 30: recover keeps the recorded Adapter", () => {
  test(
    "a stale result settled by recover keeps the adapter it recorded, so a Continuation with no --adapter still inherits it",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const first = await run({
          task: "one",
          cwd: repo.path,
          home: home.path,
          name: "stale-adapter",
          adapter: namedAdapter("other-agent", fakeAgent({ launch: "round one" })),
        });
        expect(first.adapter).toBe("other-agent");

        // A round that re-locked after this result was written, then died before writing its own,
        // is what makes `settleResult` treat the result on disk as stale and rebuild it.
        const lockPath = runLockPath(first.run, home.path);
        const record = JSON.parse(readFileSync(lockPath, "utf8"));
        await Bun.sleep(10);
        writeFileSync(lockPath, JSON.stringify(record));

        const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });
        expect(recovered.exitCode).toBe(0);

        const settled = readResult(first.run, home.path)!;
        expect(settled.status).toBe("not-converged");
        expect(settled.adapter).toBe("other-agent");

        let inherited: { adapterName: string; runId: string } | undefined;
        const continued = await run({
          task: "more",
          cwd: repo.path,
          home: home.path,
          continue: "stale-adapter",
          adapterByName: (name) => namedAdapter(name, fakeAgent({ continue: "round two" })),
          onAdapterInherited: (adapterName, runId) => {
            inherited = { adapterName, runId };
          },
        });

        expect(inherited).toEqual({ adapterName: "other-agent", runId: first.run });
        expect(continued.adapter).toBe("other-agent");
        expect(continued.finalMessage).toBe("round two");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    90_000,
  );
});

describe("a Continuation stopped while queued for a Slot leaves the earlier round current", () => {
  test("status still reports that round's result, and recover leaves it untouched", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    let holder: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    try {
      writeFileSync(path.join(home.path, "config"), "max_parallel = 1\n");
      const started = await runCli(["run", "x", "--gate", "true", "--json", "--name", "queued/continuation", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      expect(started.exitCode).toBe(0);
      const first = JSON.parse(started.stdout) as RunResult;
      expect(first.status).toBe("verified");
      const resultBefore = readFileSync(runResultPath(first.run, home.path), "utf8");

      holder = Bun.spawn(["bun", "run", HOLD_SLOT, home.path], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("held 1");

      const continuation = startCli(["run", "--continue", "queued/continuation", "more", "--json"], {
        cwd: repo.path,
        home: home.path,
      });
      await waitFor(() => continuation.stderr().includes("Waiting for a free Slot"));
      continuation.proc.kill("SIGINT");
      expect((await continuation.finished()).exitCode).not.toBe(0);

      const status = await runCli(["status"], { cwd: repo.path, home: home.path });
      const line = status.stdout.split("\n").find((entry) => entry.startsWith(first.run));
      expect(line).toContain("verified");

      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });
      expect(recovered.exitCode).toBe(0);
      expect(recovered.stdout.trim()).toBe("Nothing to recover.");
      expect(readFileSync(runResultPath(first.run, home.path), "utf8")).toBe(resultBefore);
    } finally {
      holder?.kill("SIGKILL");
      await holder?.exited;
      home.cleanup();
      repo.cleanup();
    }
  }, 90_000);
});
