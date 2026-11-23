import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Adapter, AdapterContext } from "../src/adapter";
import { DEFAULT_SCRIPT, FakeAdapter, GATE_FIXING_SCRIPT } from "../src/adapters/fake";
import { run } from "../src/run";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { onlyRunId, readLog, removeRunContainers, runContainers } from "./support/runState";

const GATE_CMD = '[ "$(cat GATE_TARGET.txt)" = ok ]';

const UNCOMMITTED_FIX: readonly string[] = ["echo 'ok' > GATE_TARGET.txt"];

const COMMIT_THE_FIX: readonly string[] = [
  "git add GATE_TARGET.txt",
  "git commit --quiet -m 'fix: make the Gate green'",
];

function recordingAdapter(inner: Adapter): { adapter: Adapter; feedbacks: string[] } {
  const feedbacks: string[] = [];
  const adapter: Adapter = {
    name: inner.name,
    sessionStore: inner.sessionStore,
    declarePreStart: (projectImage: string) => inner.declarePreStart(projectImage),
    launch: (ctx: AdapterContext) => inner.launch(ctx),
    reportCompletion: (ctx: AdapterContext) => inner.reportCompletion(ctx),
    sessionId: () => inner.sessionId?.(),
    continueSession: (ctx: AdapterContext, sessionId: string, request: string) =>
      inner.continueSession!(ctx, sessionId, request),
    async resumeWithFeedback(ctx: AdapterContext, feedback: string) {
      feedbacks.push(feedback);
      return inner.resumeWithFeedback(ctx, feedback);
    },
  };
  return { adapter, feedbacks };
}

const SESSION_STORE = "/crisol-fake-sessions";

/**
 * `bun install` 1.4.4 rewrites an empty bun.lock and installs a `file:` dependency without the
 * registry, leaving ` M bun.lock` and `?? node_modules/` (read live in crisol-base:0.2.0).
 */
function commitInstallThatDirtiesTheClone(repoPath: string): void {
  mkdirSync(path.join(repoPath, "dep"));
  writeFileSync(path.join(repoPath, "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  writeFileSync(
    path.join(repoPath, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", dependencies: { dep: "file:./dep" } }),
  );
  writeFileSync(path.join(repoPath, "bun.lock"), "");
  for (const args of [["add", "."], ["commit", "--quiet", "-m", "chore: add a local dependency"]]) {
    const proc = Bun.spawnSync(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString("utf8")}`);
  }
}

function hostHasFile(repoPath: string, branch: string, file: string): boolean {
  return Bun.spawnSync(["git", "-C", repoPath, "cat-file", "-e", `refs/heads/${branch}:${file}`]).exitCode === 0;
}

describe("Gates judge the branch Fetch-back returns, never the working tree", () => {
  test(
    "an agent that leaves its change uncommitted never ends verified, and no Gate runs on it",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const { adapter, feedbacks } = recordingAdapter(new FakeAdapter(UNCOMMITTED_FIX, UNCOMMITTED_FIX));

        const result = await run({
          task: "fix the gate",
          cwd: repo.path,
          home: home.path,
          adapter,
          gates: [GATE_CMD],
          maxIterations: 2,
        });

        expect(result).toMatchObject({ status: "not-converged", reason: "ceiling", iterations: 2 });
        expect(result.gates).toEqual([]);
        expect(feedbacks).toHaveLength(1);
        expect(feedbacks[0]).toContain("GATE_TARGET.txt");
        expect(feedbacks[0]).toContain(result.branch);
        expect(hostHasFile(repo.path, result.branch, "GATE_TARGET.txt")).toBe(false);
        expect(readLog(onlyRunId(home.path), home.path)).not.toContain("gates (iteration");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    90_000,
  );

  test(
    "an agent told its change is uncommitted can commit it and end verified",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const { adapter, feedbacks } = recordingAdapter(new FakeAdapter(UNCOMMITTED_FIX, COMMIT_THE_FIX));

        const result = await run({ task: "fix the gate", cwd: repo.path, home: home.path, adapter, gates: [GATE_CMD] });

        expect(result).toMatchObject({ status: "verified", iterations: 2 });
        expect(result.gates).toEqual([{ cmd: GATE_CMD, ok: true }]);
        expect(feedbacks).toHaveLength(1);
        expect(feedbacks[0]).not.toContain("Gate failed");
        expect(hostHasFile(repo.path, result.branch, "GATE_TARGET.txt")).toBe(true);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    90_000,
  );

  test(
    "an agent that commits its change ends verified at once, as before",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({
          task: "fix the gate",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(GATE_FIXING_SCRIPT),
          gates: [GATE_CMD],
        });

        expect(result).toMatchObject({ status: "verified", iterations: 1 });
        expect(hostHasFile(repo.path, result.branch, "GATE_TARGET.txt")).toBe(true);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    90_000,
  );

  test(
    "an agent that leaves HEAD off the Run's branch is told so before any Gate runs",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const { adapter, feedbacks } = recordingAdapter(
          new FakeAdapter([...GATE_FIXING_SCRIPT, "git checkout --quiet --detach"], ["git checkout --quiet feature/committed"]),
        );

        const result = await run({
          task: "fix the gate",
          cwd: repo.path,
          home: home.path,
          name: "feature/committed",
          adapter,
          gates: [GATE_CMD],
        });

        expect(result).toMatchObject({ status: "verified", iterations: 2 });
        expect(feedbacks).toHaveLength(1);
        expect(feedbacks[0]).toContain("detached");
        expect(feedbacks[0]).toContain("refs/heads/feature/committed");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    90_000,
  );

  test(
    "the check runs inside the Sandbox and its time counts against the ceiling",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      const markers = mkdtempSync(path.join(tmpdir(), "crisol-host-marker-"));
      const budgetMs = 3_000;
      let id: string | undefined;
      try {
        // `git status` waits on a core.fsmonitor hook, and this one never answers.
        const plantHangingFsmonitor = [
          ...DEFAULT_SCRIPT,
          `printf '#!/bin/sh\\ntouch ${markers}/fsmonitor 2>/dev/null\\nexec tail -f /dev/null\\n' > .git/fsmonitor`,
          "chmod +x .git/fsmonitor",
          'git config core.fsmonitor "$PWD/.git/fsmonitor"',
        ];
        const startedAt = Date.now();

        const result = await run({
          task: "hang the check",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(plantHangingFsmonitor),
          gates: ["true"],
          maxIterations: 1000,
          ceilingMs: budgetMs,
        });
        const elapsedMs = Date.now() - startedAt;
        id = onlyRunId(home.path);

        expect(result).toMatchObject({ status: "not-converged", reason: "ceiling", fetchBack: true });
        expect(elapsedMs).toBeGreaterThanOrEqual(budgetMs);
        expect(readLog(id, home.path)).toContain(`ceiling reached: ${budgetMs}ms`);
        expect(runContainers(id)).toEqual([]);
        expect(readdirSync(markers)).toEqual([]);
      } finally {
        if (id !== undefined) removeRunContainers(id);
        rmSync(markers, { recursive: true, force: true });
        home.cleanup();
        repo.cleanup();
      }
    },
    90_000,
  );
});

describe("the dependency install's own dirt never blocks the Gates", () => {
  test(
    "an install that rewrites the lockfile and leaves node_modules untracked still lets a committing agent end verified",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        commitInstallThatDirtiesTheClone(repo.path);

        const result = await run({
          task: "fix the gate",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(GATE_FIXING_SCRIPT),
          gates: [GATE_CMD],
        });

        expect(result).toMatchObject({ status: "verified", iterations: 1 });
        expect(readLog(onlyRunId(home.path), home.path)).toContain("dependencies installed with bun");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    120_000,
  );

  test(
    "a Continuation still excuses the first install's dirt, never what the round before left uncommitted",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        commitInstallThatDirtiesTheClone(repo.path);
        const first = await run({
          task: "fix the gate",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(UNCOMMITTED_FIX, undefined, undefined, {}, { store: SESSION_STORE }),
          gates: [GATE_CMD],
          maxIterations: 1,
        });
        expect(first).toMatchObject({ status: "not-converged", reason: "ceiling" });

        const { adapter, feedbacks } = recordingAdapter(
          new FakeAdapter(DEFAULT_SCRIPT, COMMIT_THE_FIX, undefined, {}, { store: SESSION_STORE, continueScript: ["true"] }),
        );
        const continued = await run({
          task: "finish it",
          cwd: repo.path,
          home: home.path,
          continue: first.branch,
          adapter,
          gates: [GATE_CMD],
          maxIterations: 2,
        });

        expect(continued).toMatchObject({ status: "verified", iterations: 2 });
        expect(feedbacks).toHaveLength(1);
        expect(feedbacks[0]).toContain("GATE_TARGET.txt");
        expect(feedbacks[0]).not.toContain("bun.lock");
        expect(feedbacks[0]).not.toContain("node_modules");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    180_000,
  );
});
