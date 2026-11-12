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

/** Refused BEFORE any side effect — never left for `fetchBack`'s own fix to catch after the whole Run already ran. */
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

/** A git ref directory/file collision, caught here BEFORE any side effect rather than only at Fetch-back once the whole Run already happened for nothing. */
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
 * A default-named Run must fail before any side effect too — not just an explicit
 * `--name`. Retrying with a fresh id can never help here, since every `crisol/<id>`
 * collides with the SAME "crisol" branch regardless of id.
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

/** `ensureImage` is a test seam, since forcing a REAL `docker build` to fail deterministically isn't practical in a test. */
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
 * A sha that's still physically in the object store but unreachable from every ref
 * must be refused up front, not left to the Clone's misleading "is not a commit" error.
 */
describe("--base <unreachable sha> fails before any side effect (failure path, finding 4)", () => {
  test("a sha that exists in the object store but isn't reachable from any ref is refused, not left to the Clone's misleading error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      // An orphaned commit: exists in the object store, but no branch or tag names it
      // once the branch that pointed at it is force-deleted.
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
 * A remote-tracking ref (`origin/main` ahead of local) is reachable from nothing
 * `cloneLocal` actually walks — must be refused, not left to fail deep inside
 * `checkoutNewBranch`.
 */
describe("--base origin/<branch> ahead of every local branch (failure path, round-4 finding C1)", () => {
  test("refuses before any side effect — the Clone never receives objects only reachable via refs/remotes", async () => {
    const home = createTempHome();
    const upstream = createFixtureRepo();
    const hostPath = mkdtempSync(path.join(tmpdir(), "crisol-host-"));
    try {
      // A real clone of `upstream`, so `hostPath` has its own `origin` remote-tracking refs.
      Bun.spawnSync(["git", "clone", "--quiet", upstream.path, hostPath]);
      Bun.spawnSync(["git", "-C", hostPath, "config", "user.name", "Crisol Fixture"]);
      Bun.spawnSync(["git", "-C", hostPath, "config", "user.email", "fixture@crisol.test"]);

      // Upstream advances and `host` fetches — the everyday "fetched but not merged" shape.
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
      expect(result.stderr).not.toContain("is not a commit");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      upstream.cleanup();
      rmSync(hostPath, { recursive: true, force: true });
    }
  }, 30_000);
});

/** A stash entry's commit is reachable from nothing `cloneLocal` ever walks either — same mismatch, a different ref namespace. */
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

/** `git` stays resolvable (via `/usr/bin`, system git) so the failure is isolated to the docker-reachability check, not an earlier git call. */
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
      // Crisol's OWN plain message, never Bun's raw spawn-failure wording or ENOENT/errno internals.
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
 * `cloneLocal`/`checkoutNewBranch` used to run OUTSIDE the try/catch that sets
 * `primaryError`, so a failure there propagated straight out of `run()` with the Run log
 * holding ONLY the "starting" line. `ensureImage` is repurposed here to sabotage the HOST
 * repo's permissions right before `cloneLocal` runs — the one clean hook to force a REAL
 * git clone to fail deterministically.
 */
describe("a Clone failure still lands in the Run log (failure path, finding 5)", () => {
  test("cloneLocal failing is logged, not left with only the 'starting' line", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      // `fetchBack` also runs against the same (still chmod'd) repo and usually fails
      // too, so this asserts on the LOG's "primary error:" line, not the thrown error.
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
      // Before the fix, this was the ONLY line in the log.
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
      // git's own stderr must surface — not an empty, swallowed message.
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
