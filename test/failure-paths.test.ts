import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Adapter } from "../src/adapter";
import { run } from "../src/run";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { runCli } from "./support/cli";

/**
 * The required failure-path tests: non-git cwd, an Adapter throw (primary
 * error surfaces, Fetch-back still ran), a branch collision (refused
 * before any clone, no runs/<id> created), and a missing identity. Plus
 * W5's Docker-unreachable path and W4's double-failure (AggregateError).
 */
describe("non-git cwd (failure path)", () => {
  test("fails before any side effect, naming the problem", async () => {
    const home = createTempHome();
    const plainDir = mkdtempSync(path.join(tmpdir(), "crisol-nongit-"));
    try {
      const result = await runCli(["run", "say hello", "--json"], {
        cwd: plainDir,
        home: home.path,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Not inside a git repo");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

describe("branch-name collision (failure path, W3/W5)", () => {
  test("refuses before any clone, with no runs/<id> ever created", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      Bun.spawnSync(["git", "-C", repo.path, "branch", "taken"]);

      const result = await runCli(["run", "say hello", "--json", "--name", "taken"], {
        cwd: repo.path,
        home: home.path,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("taken");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("an invalid branch name is also refused before any side effect", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--json", "--name", "..bad.."], {
        cwd: repo.path,
        home: home.path,
      });

      expect(result.exitCode).toBe(1);
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

/**
 * finding 1 (CRITICAL/pre-check half): a `--name` ambiguous with an
 * existing tag, or one that already starts with `refs/`, is refused BEFORE
 * any side effect — never left for `fetchBack`'s own qualified-refspec fix
 * and post-fetch verification to catch after the whole Run already ran.
 */
describe("--name ambiguous with an existing tag (failure path, finding 1)", () => {
  test("refuses before any clone when --name collides with an existing tag", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      Bun.spawnSync(["git", "-C", repo.path, "tag", "v1.0"]);

      const result = await runCli(["run", "say hello", "--json", "--name", "v1.0"], {
        cwd: repo.path,
        home: home.path,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("v1.0");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("--name starting with refs/ (failure path, finding 1)", () => {
  test("refuses before any side effect", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--json", "--name", "refs/heads/evil"], {
        cwd: repo.path,
        home: home.path,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("refs/");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

/**
 * finding 2 (WARNING): `--name crisol` while `crisol/<id>` exists (or the
 * reverse) is a git ref directory/file collision, caught here BEFORE any
 * side effect rather than only at Fetch-back once the whole Run already
 * happened for nothing.
 */
describe("--name D/F prefix collision with an existing branch (failure path, finding 2)", () => {
  test("refuses before any clone when --name is an existing branch's directory prefix", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      Bun.spawnSync(["git", "-C", repo.path, "branch", "crisol/existing-run"]);

      const result = await runCli(["run", "say hello", "--json", "--name", "crisol"], {
        cwd: repo.path,
        home: home.path,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("crisol");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("refuses before any clone when --name's directory prefix is an existing branch (the reverse)", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      Bun.spawnSync(["git", "-C", repo.path, "branch", "crisol"]);

      const result = await runCli(["run", "say hello", "--json", "--name", "crisol/new-run"], {
        cwd: repo.path,
        home: home.path,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("crisol/new-run");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

/**
 * finding 1 (round-3 review, CRITICAL): a DEFAULT-named Run (no `--name`)
 * never ran `assertBranchAvailable` at all — only an explicit `--name` did.
 * `reserveRun` only checked `branchExists` for the generated `crisol/<id>`,
 * so a host with a plain branch literally named "crisol" blocked EVERY
 * default-named Run's branch at Fetch-back time ('cannot lock ref
 * "refs/heads/crisol/<id>": "refs/heads/crisol" exists'), after the whole
 * Run (Clone, Sandbox, Adapter) had already happened for nothing. Retrying
 * with a fresh id can never help here — every `crisol/<id>` collides with
 * the SAME "crisol" branch regardless of id — so this must fail BEFORE any
 * side effect, with a plain message naming the one way out: `--name`.
 */
describe("a default-named Run collides with a plain \"crisol\" branch (failure path, finding 1 CRITICAL)", () => {
  test("refuses before any side effect, pointing at --name as the way out", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      Bun.spawnSync(["git", "-C", repo.path, "branch", "crisol"]);

      const result = await runCli(["run", "say hello", "--json"], {
        cwd: repo.path,
        home: home.path,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("crisol");
      expect(result.stderr).toContain("--name");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

/**
 * finding 5: `ensureBaseImage` must run BEFORE any side effect — an offline
 * first Run (image build fails) must never leave a Clone+cut branch behind.
 * `ensureImage` is a test seam on `RunOptions` (same pattern as
 * `generateRunId`) since forcing a REAL `docker build` to fail
 * deterministically isn't practical in a test.
 */
describe("ensureBaseImage runs before any side effect (failure path, finding 5)", () => {
  test("an image-resolution failure leaves no run directory, no Clone, and no branch behind", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      await expect(
        run({
          task: "x",
          cwd: repo.path,
          home: home.path,
          ensureImage: async () => {
            throw new Error("simulated offline image-build failure");
          },
        }),
      ).rejects.toThrow("simulated offline image-build failure");

      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

/**
 * finding 4 (round-3 review, WARNING): `resolveBaseSha`'s own check is
 * existence-only (`rev-parse <ref>^{commit}`) — a sha that is still
 * physically in the object store but unreachable from every ref (its
 * branch was force-deleted, no `git gc` has run yet) happily passes it,
 * then fails much later, deep inside the `--no-local file://` Clone's own
 * checkout, with git's misleading "'<sha>' is not a commit and a branch
 * '<name>' cannot be created from it" — by which point `reserveRun`'s mkdir
 * and the Clone itself have already happened. Reachability is now checked
 * up front, before any side effect, with a plain message naming the sha.
 */
describe("--base <unreachable sha> fails before any side effect (failure path, finding 4)", () => {
  test("a sha that exists in the object store but isn't reachable from any ref is refused, not left to the Clone's misleading error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      // An orphaned commit: exists in the object store (no `git gc` run),
      // but no branch or tag names it after the branch that pointed at it
      // is force-deleted.
      Bun.spawnSync(["git", "-C", repo.path, "checkout", "-q", "-b", "tmp"]);
      writeFileSync(`${repo.path}/orphan.txt`, "orphan\n");
      Bun.spawnSync(["git", "-C", repo.path, "add", "orphan.txt"]);
      Bun.spawnSync(["git", "-C", repo.path, "commit", "-q", "-m", "orphaned commit"]);
      const orphanSha = Bun.spawnSync(["git", "-C", repo.path, "rev-parse", "--short", "HEAD"], {
        stdout: "pipe",
      })
        .stdout.toString("utf8")
        .trim();
      Bun.spawnSync(["git", "-C", repo.path, "checkout", "-q", "main"]);
      Bun.spawnSync(["git", "-C", repo.path, "branch", "-D", "tmp"]);

      const result = await runCli(["run", "say hello", "--json", "--base", orphanSha], {
        cwd: repo.path,
        home: home.path,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(orphanSha);
      expect(result.stderr.toLowerCase()).toContain("reachable");
      expect(result.stderr).not.toContain("is not a commit");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

/**
 * Round-4 review, finding C1 (WARNING, both reviewers reproduced): the old
 * `isReachableFromAnyRef` ran `git for-each-ref --contains <sha>` with NO
 * pattern, which lists refs under ALL of `refs/` — including
 * `refs/remotes/*`, which `cloneLocal`'s `--no-local file://` transport
 * never walks (a remote-tracking ref is a purely local bookkeeping concept;
 * the host repo never advertises it to anything cloning from it). So
 * `--base origin/main` ahead of every local branch used to pass this
 * pre-side-effect check, then fail much later inside `checkoutNewBranch`
 * with git's own misleading "is not a commit" — after the run dir and the
 * Clone had already been created. Fixed by scoping the check to exactly
 * what the Clone receives (`refs/heads/`, `refs/tags/`, and HEAD).
 */
describe("--base origin/<branch> ahead of every local branch (failure path, round-4 finding C1)", () => {
  test("refuses before any side effect — the Clone never receives objects only reachable via refs/remotes", async () => {
    const home = createTempHome();
    const upstream = createFixtureRepo();
    const hostPath = mkdtempSync(path.join(tmpdir(), "crisol-host-"));
    try {
      // `host` is a real clone of `upstream`, so it has its own `origin`
      // remote-tracking refs, same as any real-world checkout.
      Bun.spawnSync(["git", "clone", "--quiet", upstream.path, hostPath]);
      Bun.spawnSync(["git", "-C", hostPath, "config", "user.name", "Crisol Fixture"]);
      Bun.spawnSync(["git", "-C", hostPath, "config", "user.email", "fixture@crisol.test"]);

      // Upstream advances; `host` fetches so `refs/remotes/origin/main`
      // moves ahead while `host`'s own local `main` stays behind — exactly
      // the everyday "fetched but not merged" shape.
      writeFileSync(path.join(upstream.path, "ahead.txt"), "ahead\n");
      Bun.spawnSync(["git", "-C", upstream.path, "add", "ahead.txt"]);
      Bun.spawnSync(["git", "-C", upstream.path, "commit", "--quiet", "-m", "chore: upstream advances"]);
      Bun.spawnSync(["git", "-C", hostPath, "fetch", "--quiet", "origin"]);

      const aheadSha = Bun.spawnSync(
        ["git", "-C", hostPath, "rev-parse", "--short", "origin/main"],
        { stdout: "pipe" },
      )
        .stdout.toString("utf8")
        .trim();

      const result = await runCli(["run", "say hello", "--json", "--base", "origin/main"], {
        cwd: hostPath,
        home: home.path,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(aheadSha);
      expect(result.stderr.toLowerCase()).toContain("reachable");
      // Never reaches checkoutNewBranch's own misleading git error.
      expect(result.stderr).not.toContain("is not a commit");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      upstream.cleanup();
      rmSync(hostPath, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * Round-4 review, finding C1: same mismatch, a different ref namespace the
 * old ALL-refs check also matched — `refs/stash`. A stash entry's commit is
 * reachable from nothing `cloneLocal` ever walks either.
 */
describe("--base <stash sha> (failure path, round-4 finding C1)", () => {
  test("refuses before any side effect — a stash entry never crosses into the Clone", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "README.md"), "# fixture\ndirty\n");
      Bun.spawnSync(["git", "-C", repo.path, "stash", "push", "--quiet", "-m", "secret stash"]);
      const stashSha = Bun.spawnSync(
        ["git", "-C", repo.path, "rev-parse", "--short", "stash@{0}"],
        { stdout: "pipe" },
      )
        .stdout.toString("utf8")
        .trim();

      const result = await runCli(["run", "say hello", "--json", "--base", stashSha], {
        cwd: repo.path,
        home: home.path,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(stashSha);
      expect(result.stderr.toLowerCase()).toContain("reachable");
      expect(result.stderr).not.toContain("is not a commit");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 30_000);
});

/**
 * Cheap extra: the docker CLI itself being missing from PATH must print a
 * plain message naming docker, never a raw `Bun.spawnSync` ENOENT. `git`
 * stays resolvable (via `/usr/bin`, system git) so the failure is isolated
 * to the docker-reachability check, not an earlier git call.
 */
describe("docker CLI missing from PATH (failure path, extra)", () => {
  test("fails with a plain message naming docker, not a spawn ENOENT", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--json"], {
        cwd: repo.path,
        home: home.path,
        env: { PATH: "/opt/homebrew/bin:/usr/bin" },
      });

      expect(result.exitCode).toBe(1);
      // Crisol's OWN plain message, never Bun's raw spawn-failure wording
      // ("Executable not found in $PATH: ...") or its ENOENT/errno
      // internals.
      expect(result.stderr).toContain("was not found on PATH");
      expect(result.stderr.toLowerCase()).toContain("install docker");
      expect(result.stderr).not.toContain("ENOENT");
      expect(result.stderr).not.toContain("$PATH:");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 30_000);
});

describe("missing git identity (failure path, W5)", () => {
  test("fails before any side effect, naming the problem plainly", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      Bun.spawnSync(["git", "-C", repo.path, "config", "--unset", "user.name"]);
      Bun.spawnSync(["git", "-C", repo.path, "config", "--unset", "user.email"]);

      const result = await runCli(["run", "say hello", "--json"], {
        cwd: repo.path,
        home: home.path,
        env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain("identity");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("Docker engine unreachable (failure path, W5)", () => {
  test("fails before any side effect, naming Docker", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--json"], {
        cwd: repo.path,
        home: home.path,
        env: { DOCKER_HOST: "unix:///tmp/crisol-test-nonexistent-engine.sock" },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain("docker");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 30_000);
});

/**
 * finding 5 (round-3 review, CONFIRMED): `cloneLocal`/`checkoutNewBranch`
 * run OUTSIDE the try/catch that sets `primaryError` — so a failure there
 * propagates straight out of `run()`, and the Run log is left holding ONLY
 * the "starting" line, never the failure itself (unlike every OTHER
 * failure path, which always appends a "primary error: ..." line). The
 * `ensureImage` seam is the one hook that runs AFTER every pre-side-effect
 * check but BEFORE `cloneLocal` — used here to sabotage the HOST repo's
 * permissions so the upcoming Clone fails for real (forcing a REAL git
 * clone to fail deterministically otherwise has no clean hook, same
 * reasoning as the `ensureImage` seam's own doc comment).
 */
describe("a Clone failure still lands in the Run log (failure path, finding 5)", () => {
  test("cloneLocal failing is logged, not left with only the 'starting' line", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      // `fetchBack` ALSO runs against the same (still chmod'd) host repo
      // and will usually ALSO fail — the top-level thrown error can end up
      // an `AggregateError` whose own `.message` doesn't carry either
      // underlying git message, so this asserts on the LOG's "primary
      // error:" line instead of the thrown error's message.
      let caught: unknown;
      try {
        await run({
          task: "x",
          cwd: repo.path,
          home: home.path,
          ensureImage: async () => {
            chmodSync(repo.path, 0o000);
            return "irrelevant-image-tag";
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();

      const runs = readdirSync(path.join(home.path, "runs"));
      expect(runs).toHaveLength(1);
      const log = readFileSync(path.join(home.path, "runs", runs[0]!, "log"), "utf8");
      expect(log).toContain("run ");
      expect(log).toContain("starting");
      // Before the fix, this was the ONLY line in the log — the Clone
      // failure happened outside any try/catch and was never appended.
      const primaryErrorLine = log.split("\n").find((line) => line.includes("primary error:"));
      expect(primaryErrorLine).toBeDefined();
      expect(primaryErrorLine).toMatch(/git repository|remote repository/i);
    } finally {
      chmodSync(repo.path, 0o755);
      home.cleanup();
      repo.cleanup();
    }
  }, 30_000);
});

describe("Adapter failure (failure path, W4)", () => {
  test("the primary error surfaces, and Fetch-back still runs", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const throwingAdapter: Adapter = {
        declarePreStart() {
          return { envNames: [], mounts: [] };
        },
        async launch() {
          throw new Error("adapter exploded");
        },
        async reportCompletion() {
          return true;
        },
        async resumeWithFeedback() {},
      };

      await expect(
        run({ task: "x", cwd: repo.path, home: home.path, adapter: throwingAdapter }),
      ).rejects.toThrow("adapter exploded");

      const runs = readdirSync(path.join(home.path, "runs"));
      expect(runs).toHaveLength(1);
      const log = readFileSync(path.join(home.path, "runs", runs[0]!, "log"), "utf8");
      expect(log).toContain("primary error: adapter exploded");
      expect(log).toContain("fetch-back complete");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("when Fetch-back ALSO fails, both errors surface (AggregateError) and both are logged", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const throwingAdapter: Adapter = {
        declarePreStart() {
          return { envNames: [], mounts: [] };
        },
        async launch(ctx) {
          // Destroy the Clone's own .git from INSIDE the Sandbox so the
          // later host-side Fetch-back has nothing to fetch from.
          await ctx.sandbox.exec(["rm", "-rf", `${ctx.repoPath}/.git`]);
          throw new Error("adapter exploded");
        },
        async reportCompletion() {
          return true;
        },
        async resumeWithFeedback() {},
      };

      let caught: unknown;
      try {
        await run({ task: "x", cwd: repo.path, home: home.path, adapter: throwingAdapter });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      const agg = caught as AggregateError;
      expect(agg.errors).toHaveLength(2);
      expect(String(agg.errors[0])).toContain("adapter exploded");
      // W3: git's own stderr must surface — not an empty, swallowed message.
      expect(String(agg.errors[1]).length).toBeGreaterThan("fetch-back failed: ".length);

      const runs = readdirSync(path.join(home.path, "runs"));
      const log = readFileSync(path.join(home.path, "runs", runs[0]!, "log"), "utf8");
      expect(log).toContain("primary error: adapter exploded");
      const fetchFailureLine = log.split("\n").find((line) => line.includes("fetch-back failed"));
      expect(fetchFailureLine).toBeDefined();
      // The line must carry an actual reason from git, not just the prefix.
      expect(fetchFailureLine!.length).toBeGreaterThan("fetch-back failed: ".length + 20);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});
