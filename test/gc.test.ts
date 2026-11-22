import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { Adapter } from "../src/adapter";
import { FakeAdapter } from "../src/adapters/fake";
import { addTrackedSize, collectRun, formatSizeWarning, planGc, reconcileTrackedSize, runDirSizeBytes, trackedRunsSizeBytes } from "../src/gc";
import { checkoutNewBranch, cloneLocal, discoverGitRoot, shortSha } from "../src/git";
import { runDir, runLockPath, runLogPath, runNetworkDir, runRepoPath, runResultPath, runSessionIdPath } from "../src/paths";
import { run } from "../src/run";
import type { RunResult } from "../src/run";
import { tryLockRun } from "../src/slots";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { onlyRunId, readLog, readResult, refSha } from "./support/runState";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fabricates a finished Run's on-disk state without Docker. */
function writeFakeRun(
  home: string,
  hostRepoPath: string,
  options: { id: string; branch: string; status: RunResult["status"]; fetchBack: boolean; finishedAt: number },
): void {
  const { id, branch, status, fetchBack, finishedAt } = options;
  mkdirSync(runDir(id, home), { recursive: true });
  const clonePath = runRepoPath(id, home);
  cloneLocal(hostRepoPath, clonePath);
  const headSha = shortSha(hostRepoPath, "HEAD");
  checkoutNewBranch(clonePath, branch, headSha);
  // Stands in for Fetch-back, which a fake Run never ran: the host gets the same ref, at the
  // same commit, without touching its checked-out `main`.
  Bun.spawnSync(["git", "-C", hostRepoPath, "branch", branch, headSha]);
  writeFileSync(runLockPath(id, home), JSON.stringify({ host: hostRepoPath, branch }));
  writeFileSync(runLogPath(id, home), "fake run\n");
  mkdirSync(runNetworkDir(id, home), { recursive: true });
  writeFileSync(path.join(runNetworkDir(id, home), "tinyproxy.conf"), "dummy\n");
  const result: RunResult = {
    run: id,
    branch,
    base: `main@${headSha}`,
    status,
    iterations: 1,
    gates: [],
    network: "allowlist",
    blocked: [],
    warnings: [],
    fetchBack,
    finishedAt,
  };
  writeFileSync(runResultPath(id, home), JSON.stringify(result, null, 2));
}

function ageResultBy(id: string, home: string, days: number): void {
  const resultPath = runResultPath(id, home);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
  result.finishedAt = Date.now() - days * DAY_MS;
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
}

describe("planGc, no Docker needed", () => {
  test("a verified Run past 7 days, Fetch-back complete, host branch unmoved: collectable", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFakeRun(home.path, repo.path, {
        id: "r1",
        branch: "crisol/r1",
        status: "verified",
        fetchBack: true,
        finishedAt: Date.now() - 8 * DAY_MS,
      });
      const plan = planGc(home.path, { includeFailed: false });
      expect(plan.collectable.map((c) => c.run)).toEqual(["r1"]);
      expect(plan.collectable[0]!.sizeBytes).toBeGreaterThan(0);
      expect(plan.skipped).toEqual([]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("younger than 7 days is kept, named too-young", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFakeRun(home.path, repo.path, {
        id: "r1",
        branch: "crisol/r1",
        status: "verified",
        fetchBack: true,
        finishedAt: Date.now() - 1 * DAY_MS,
      });
      const plan = planGc(home.path, { includeFailed: false });
      expect(plan.collectable).toEqual([]);
      expect(plan.skipped).toEqual([{ run: "r1", kind: "too-young", why: "only 1 day(s) old; gc collects after 7" }]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("without a completed Fetch-back is never collected, with or without --include-failed", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFakeRun(home.path, repo.path, {
        id: "r1",
        branch: "crisol/r1",
        status: "verified",
        fetchBack: false,
        finishedAt: Date.now() - 8 * DAY_MS,
      });
      expect(planGc(home.path, { includeFailed: false }).collectable).toEqual([]);
      expect(planGc(home.path, { includeFailed: true }).collectable).toEqual([]);
      expect(planGc(home.path, { includeFailed: true }).skipped[0]).toMatchObject({ run: "r1", kind: "not-fetched-back" });
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("a not-converged Run stays unless --include-failed", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFakeRun(home.path, repo.path, {
        id: "r1",
        branch: "crisol/r1",
        status: "not-converged",
        fetchBack: true,
        finishedAt: Date.now() - 8 * DAY_MS,
      });
      expect(planGc(home.path, { includeFailed: false }).collectable).toEqual([]);
      expect(planGc(home.path, { includeFailed: true }).collectable.map((c) => c.run)).toEqual(["r1"]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  for (const status of ["parked", "checkpoint"] as const) {
    test(`a ${status} Run past 7 days waits for a Continuation, never collected by age`, () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        writeFakeRun(home.path, repo.path, {
          id: "r1",
          branch: "crisol/r1",
          status,
          fetchBack: true,
          finishedAt: Date.now() - 8 * DAY_MS,
        });
        const plan = planGc(home.path, { includeFailed: false });
        expect(plan.collectable).toEqual([]);
        expect(plan.skipped[0]).toMatchObject({ run: "r1", kind: "awaits-continuation" });
        const why = plan.skipped[0]!.why;
        expect(why).toContain(status);
        expect(why).toContain(`repo/, sessions/ and network/ under ${runDir("r1", home.path)}`);
        expect(why).toContain("log and result.json");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    });

    test(`a ${status} Run whose repo/, sessions/ and network/ were removed by hand is no longer reported`, () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        writeFakeRun(home.path, repo.path, {
          id: "r1",
          branch: "crisol/r1",
          status,
          fetchBack: true,
          finishedAt: Date.now() - 8 * DAY_MS,
        });
        collectRun("r1", home.path);
        expect(planGc(home.path, { includeFailed: false })).toEqual({ collectable: [], skipped: [] });
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    });
  }

  test("refuses a Run whose host branch moved off the recorded commit, naming the reason", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFakeRun(home.path, repo.path, {
        id: "r1",
        branch: "crisol/r1",
        status: "verified",
        fetchBack: true,
        finishedAt: Date.now() - 8 * DAY_MS,
      });
      Bun.spawnSync(["git", "-C", repo.path, "checkout", "--quiet", "crisol/r1"]);
      Bun.spawnSync(["git", "-C", repo.path, "commit", "--quiet", "--allow-empty", "-m", "moved on"]);

      const plan = planGc(home.path, { includeFailed: false });
      expect(plan.collectable).toEqual([]);
      expect(plan.skipped[0]).toMatchObject({ run: "r1", kind: "branch-moved" });
      expect(plan.skipped[0]!.why).toContain("crisol/r1");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("refuses when the host repo is gone", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    writeFakeRun(home.path, repo.path, {
      id: "r1",
      branch: "crisol/r1",
      status: "verified",
      fetchBack: true,
      finishedAt: Date.now() - 8 * DAY_MS,
    });
    repo.cleanup();
    try {
      const plan = planGc(home.path, { includeFailed: false });
      expect(plan.collectable).toEqual([]);
      expect(plan.skipped[0]).toMatchObject({ run: "r1", kind: "host-missing" });
    } finally {
      home.cleanup();
    }
  });

  test("a Run result with no finishedAt (predates gc) is kept, never treated as old enough", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFakeRun(home.path, repo.path, {
        id: "r1",
        branch: "crisol/r1",
        status: "verified",
        fetchBack: true,
        finishedAt: Date.now() - 8 * DAY_MS,
      });
      const resultPath = runResultPath("r1", home.path);
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
      delete result.finishedAt;
      writeFileSync(resultPath, JSON.stringify(result));

      const plan = planGc(home.path, { includeFailed: false });
      expect(plan.collectable).toEqual([]);
      expect(plan.skipped[0]).toMatchObject({ run: "r1", kind: "no-record" });
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("a Run whose lock is held (a live Run, or a queued or running Continuation) is skipped, reported in-use", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFakeRun(home.path, repo.path, {
        id: "r1",
        branch: "crisol/r1",
        status: "verified",
        fetchBack: true,
        finishedAt: Date.now() - 8 * DAY_MS,
      });
      const held = tryLockRun(runLockPath("r1", home.path));
      expect(held).toBeDefined();
      try {
        const plan = planGc(home.path, { includeFailed: false });
        expect(plan.collectable).toEqual([]);
        expect(plan.skipped[0]).toMatchObject({ run: "r1", kind: "in-use" });
      } finally {
        held!.release();
      }
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("a collectable Run keeps its lock held past planning, so nothing else can take it until released", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFakeRun(home.path, repo.path, {
        id: "r1",
        branch: "crisol/r1",
        status: "verified",
        fetchBack: true,
        finishedAt: Date.now() - 8 * DAY_MS,
      });

      const plan = planGc(home.path, { includeFailed: false });
      expect(plan.collectable.map((c) => c.run)).toEqual(["r1"]);
      // Still pending collection: a Continuation (or a second gc) cannot take the lock meanwhile.
      expect(tryLockRun(runLockPath("r1", home.path))).toBeUndefined();

      plan.collectable[0]!.release();
      const afterRelease = tryLockRun(runLockPath("r1", home.path));
      expect(afterRelease).toBeDefined();
      afterRelease!.release();
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("crisol gc reports why it kept a Run, no Docker needed", () => {
  for (const status of ["parked", "checkpoint"] as const) {
    test(`names a ${status} Run and why, never silent like too-young, under the CRISOL_HOME in use`, async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        writeFakeRun(home.path, repo.path, {
          id: "r1",
          branch: "crisol/r1",
          status,
          fetchBack: true,
          finishedAt: Date.now() - 8 * DAY_MS,
        });
        const gc = await runCli(["gc"], { cwd: repo.path, home: home.path });
        expect(gc.exitCode).toBe(0);
        expect(gc.stdout).toContain("Nothing to collect.");
        expect(gc.stderr).toContain("Run r1: refused");
        expect(gc.stderr).toContain(status);
        expect(gc.stderr).toContain(runDir("r1", home.path));
        expect(gc.stderr).not.toContain("~/.crisol");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    }, 15_000);
  }
});

describe("collectRun, no Docker needed", () => {
  test("removes repo/ and the per-Run network/ dir, keeps log, result.json and the lock record", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFakeRun(home.path, repo.path, {
        id: "r1",
        branch: "crisol/r1",
        status: "verified",
        fetchBack: true,
        finishedAt: Date.now() - 8 * DAY_MS,
      });
      collectRun("r1", home.path);
      expect(existsSync(runRepoPath("r1", home.path))).toBe(false);
      expect(existsSync(runNetworkDir("r1", home.path))).toBe(false);
      expect(existsSync(runLogPath("r1", home.path))).toBe(true);
      expect(existsSync(runResultPath("r1", home.path))).toBe(true);
      expect(existsSync(runLockPath("r1", home.path))).toBe(true);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("never deletes the branch in the host repo", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFakeRun(home.path, repo.path, {
        id: "r1",
        branch: "crisol/r1",
        status: "verified",
        fetchBack: true,
        finishedAt: Date.now() - 8 * DAY_MS,
      });
      const before = refSha(repo.path, "crisol/r1");
      collectRun("r1", home.path);
      expect(refSha(repo.path, "crisol/r1")).toBe(before);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("never goes negative when more is subtracted than was ever added", () => {
    const home = createTempHome();
    try {
      addTrackedSize(home.path, 100);
      addTrackedSize(home.path, -1000);
      expect(trackedRunsSizeBytes(home.path)).toBe(0);
    } finally {
      home.cleanup();
    }
  });
});

describe("trackedRunsSizeBytes, no Docker needed", () => {
  test("reads as 0 with no tracker file yet, never a walk of runs/", () => {
    const home = createTempHome();
    try {
      expect(trackedRunsSizeBytes(home.path)).toBe(0);
    } finally {
      home.cleanup();
    }
  });
});

describe("reconcileTrackedSize, no Docker needed", () => {
  test("corrects a counter left too high after a Run dir is removed by hand", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFakeRun(home.path, repo.path, {
        id: "r1",
        branch: "crisol/r1",
        status: "verified",
        fetchBack: true,
        finishedAt: Date.now() - 8 * DAY_MS,
      });
      addTrackedSize(home.path, runDirSizeBytes("r1", home.path));
      collectRun("r1", home.path); // what `gc` itself tells a no-record Run's owner to do by hand
      expect(trackedRunsSizeBytes(home.path)).toBeGreaterThan(0); // stale: nothing ever subtracted this

      const reconciled = reconcileTrackedSize(home.path);

      expect(reconciled).toBe(0);
      expect(trackedRunsSizeBytes(home.path)).toBe(0);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("corrects a counter left too low, as a Run that only crisol recover brought back never added", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFakeRun(home.path, repo.path, {
        id: "r1",
        branch: "crisol/r1",
        status: "verified",
        fetchBack: true,
        finishedAt: Date.now() - 8 * DAY_MS,
      });
      const real = runDirSizeBytes("r1", home.path);
      expect(real).toBeGreaterThan(0);
      expect(trackedRunsSizeBytes(home.path)).toBe(0); // never added — the tracker's starting belief

      const reconciled = reconcileTrackedSize(home.path);

      expect(reconciled).toBe(real);
      expect(trackedRunsSizeBytes(home.path)).toBe(real);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("formatSizeWarning, no Docker needed", () => {
  test("undefined at or under the threshold", () => {
    expect(formatSizeWarning(1000, 1000)).toBeUndefined();
    expect(formatSizeWarning(999, 1000)).toBeUndefined();
  });

  test("names `crisol gc` once over the threshold", () => {
    expect(formatSizeWarning(1001, 1000)).toContain("crisol gc");
  });
});

describe("crisol gc end to end, against a real Docker engine", () => {
  test("declining the confirmation deletes nothing", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json"], { cwd: repo.path, home: home.path });
      const { run: id, branch } = JSON.parse(done.stdout) as RunResult;
      ageResultBy(id, home.path, 8);

      const gc = await runCli(["gc"], { cwd: repo.path, home: home.path, stdin: "n\n" });

      expect(gc.exitCode).toBe(0);
      expect(gc.stdout).toContain("Nothing deleted.");
      expect(existsSync(runRepoPath(id, home.path))).toBe(true);
      expect(refSha(repo.path, branch)).toBeDefined();
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("confirming collects repo/ and network/, keeps log and result.json, never touches the branch", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json"], { cwd: repo.path, home: home.path });
      const { run: id, branch } = JSON.parse(done.stdout) as RunResult;
      const beforeSha = refSha(repo.path, branch);
      ageResultBy(id, home.path, 8);

      const gc = await runCli(["gc"], { cwd: repo.path, home: home.path, stdin: "y\n" });

      expect(gc.exitCode).toBe(0);
      expect(gc.stdout).toContain(`Run ${id}: collected`);
      expect(existsSync(runRepoPath(id, home.path))).toBe(false);
      expect(existsSync(runNetworkDir(id, home.path))).toBe(false);
      expect(existsSync(runLogPath(id, home.path))).toBe(true);
      expect(readResult(id, home.path)).not.toBeUndefined();
      expect(refSha(repo.path, branch)).toBe(beforeSha);
      expect(trackedRunsSizeBytes(home.path)).toBe(0); // reconciled: nothing is left under runs/ to measure
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("reconciles the counter even when there is nothing to collect", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      addTrackedSize(home.path, 500_000_000_000); // stale drift, no Run at all to explain it

      const gc = await runCli(["gc"], { cwd: repo.path, home: home.path });

      expect(gc.stdout).toContain("Nothing to collect.");
      expect(trackedRunsSizeBytes(home.path)).toBe(0);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("reconciles the counter even when the user declines", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json"], { cwd: repo.path, home: home.path });
      const { run: id } = JSON.parse(done.stdout) as RunResult;
      ageResultBy(id, home.path, 8);
      addTrackedSize(home.path, 500_000_000_000); // stale drift from before this gc

      const gc = await runCli(["gc"], { cwd: repo.path, home: home.path, stdin: "n\n" });

      expect(gc.stdout).toContain("Nothing deleted.");
      expect(existsSync(runRepoPath(id, home.path))).toBe(true);
      expect(trackedRunsSizeBytes(home.path)).toBe(runDirSizeBytes(id, home.path));
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("refuses a Run whose host branch moved off the recorded commit", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json"], { cwd: repo.path, home: home.path });
      const { run: id, branch } = JSON.parse(done.stdout) as RunResult;
      ageResultBy(id, home.path, 8);
      Bun.spawnSync(["git", "-C", repo.path, "checkout", "--quiet", branch]);
      Bun.spawnSync(["git", "-C", repo.path, "commit", "--quiet", "--allow-empty", "-m", "moved on"]);

      const gc = await runCli(["gc"], { cwd: repo.path, home: home.path });

      expect(gc.exitCode).toBe(0);
      expect(gc.stdout).toContain("Nothing to collect.");
      expect(gc.stderr).toContain(`Run ${id}: refused`);
      expect(existsSync(runRepoPath(id, home.path))).toBe(true);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a not-converged Run needs --include-failed, on top of the same age and verification", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--gate", "false", "--max-iterations", "1", "--json"], {
        cwd: repo.path,
        home: home.path,
      });
      const result = JSON.parse(done.stdout) as RunResult;
      expect(result.status).toBe("not-converged");
      expect(result.fetchBack).toBe(true);
      ageResultBy(result.run, home.path, 8);

      const withoutFlag = await runCli(["gc"], { cwd: repo.path, home: home.path, stdin: "y\n" });
      expect(withoutFlag.stdout).toContain("Nothing to collect.");
      expect(existsSync(runRepoPath(result.run, home.path))).toBe(true);

      const withFlag = await runCli(["gc", "--include-failed"], { cwd: repo.path, home: home.path, stdin: "y\n" });
      expect(withFlag.stdout).toContain(`Run ${result.run}: collected`);
      expect(existsSync(runRepoPath(result.run, home.path))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a Run without a completed Fetch-back is never collected, even with --include-failed", async () => {
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
      await expect(run({ task: "x", cwd: repo.path, home: home.path, adapter: cloneDestroyingAdapter })).rejects.toBeInstanceOf(
        AggregateError,
      );
      const id = onlyRunId(home.path);
      expect(readResult(id, home.path)).toMatchObject({ fetchBack: false });
      ageResultBy(id, home.path, 8);

      const gc = await runCli(["gc", "--include-failed"], { cwd: repo.path, home: home.path, stdin: "y\n" });

      expect(gc.stdout).toContain("Nothing to collect.");
      expect(existsSync(runRepoPath(id, home.path))).toBe(true);
      expect(readLog(id, home.path)).toBeDefined();
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a Continuation is refused while gc holds the Run's lock, never running over a deleted Clone", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      // The real `run()` resolves `cwd` to the repo's canonical path (symlinks and all); the fake
      // Run's lock record must name that same path, or `--continue` finds no owner for the branch.
      const hostRepoPath = discoverGitRoot(repo.path)!;
      writeFakeRun(home.path, hostRepoPath, {
        id: "r1",
        branch: "crisol/r1",
        status: "verified",
        fetchBack: true,
        finishedAt: Date.now() - 8 * DAY_MS,
      });
      writeFileSync(runSessionIdPath("r1", home.path), "fake-session");

      const plan = planGc(home.path, { includeFailed: false });
      expect(plan.collectable.map((c) => c.run)).toEqual(["r1"]);
      try {
        await expect(
          run({ task: "more", cwd: repo.path, home: home.path, continue: "crisol/r1", adapter: new FakeAdapter() }),
        ).rejects.toThrow(/lock is already held/);
        expect(existsSync(runRepoPath("r1", home.path))).toBe(true);
      } finally {
        plan.collectable[0]!.release();
      }
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("crisol run's size warning (ticket 16)", () => {
  test("stays quiet under the default threshold", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await runCli(["run", "x", "--json"], { cwd: repo.path, home: home.path });
      expect(done.stderr).not.toContain("crisol gc");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("warns, naming `crisol gc`, once `gc_warn_bytes` is set low enough", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "config"), "gc_warn_bytes = 1\n");
      const done = await runCli(["run", "x", "--json"], { cwd: repo.path, home: home.path });
      expect(done.exitCode).toBe(0);
      expect(done.stderr).toContain("crisol gc");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});
