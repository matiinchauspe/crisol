import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createFixtureRepo } from "./support/fixtureRepo";
import { createTempHome } from "./support/crisolHome";
import { runCli } from "./support/cli";

function gitLog(repoPath: string, ref: string): string {
  const proc = Bun.spawnSync(["git", "-C", repoPath, "log", "--oneline", ref], { stdout: "pipe" });
  return proc.stdout.toString("utf8");
}

/**
 * The sha the branch was actually CUT from (round-4 review, finding B4):
 * the FakeAdapter's `DEFAULT_SCRIPT` makes exactly one commit on top of
 * whatever `checkoutNewBranch` started the branch at, so `<branch>~1` is
 * that starting point — the branch's PARENT, not its tip. Used to lock
 * that `checkoutNewBranch` is actually called with `baseSha`, not just that
 * the reported `base` string says so (dropping `baseSha` there still
 * passed every test that only checked the string before this fix).
 */
function branchParentSha(repoPath: string, branch: string): string {
  const proc = Bun.spawnSync(["git", "-C", repoPath, "log", "--format=%h", "-1", `${branch}~1`], {
    stdout: "pipe",
  });
  return proc.stdout.toString("utf8").trim();
}

describe("crisol run (ticket 01: walking skeleton)", () => {
  test(
    "clones the host repo, lets the fake Adapter commit, fetches the branch back, and prints the Run result",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await runCli(["run", "say hello", "--json"], {
          cwd: repo.path,
          home: home.path,
        });

        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
        const payload = JSON.parse(result.stdout);

        // The Run result matches the spec's JSON shape.
        expect(payload).toMatchObject({
          status: "unverified",
          iterations: 1,
          gates: [],
          network: "open",
          blocked: [],
          warnings: [],
        });
        expect(typeof payload.run).toBe("string");
        // W2: lengthened from the spec's own "a1b2" EXAMPLE to 8 hex chars.
        expect(payload.run).toMatch(/^[0-9a-f]{8}$/);
        expect(payload.branch).toBe(`crisol/${payload.run}`);
        expect(payload.base).toMatch(/^main@[0-9a-f]+$/);

        // The branch landed in the HOST repo with the fake Adapter's commit.
        const logText = gitLog(repo.path, payload.branch);
        expect(logText).toContain("feat: record the walking-skeleton run");

        // `~/.crisol/runs/<id>/` holds `repo/`, `log` and `result.json`.
        const runRoot = path.join(home.path, "runs", payload.run);
        expect(existsSync(path.join(runRoot, "repo"))).toBe(true);
        expect(existsSync(path.join(runRoot, "log"))).toBe(true);
        expect(existsSync(path.join(runRoot, "result.json"))).toBe(true);
        const written = JSON.parse(readFileSync(path.join(runRoot, "result.json"), "utf8"));
        expect(written).toEqual(payload);

        // The Clone has its OWN .git — not a worktree pointing back at the host.
        const clonePath = path.join(runRoot, "repo");
        const gitDir = Bun.spawnSync(["git", "-C", clonePath, "rev-parse", "--git-dir"], {
          stdout: "pipe",
        });
        expect(gitDir.stdout.toString("utf8").trim()).toBe(".git");
        expect(existsSync(path.join(clonePath, ".git"))).toBe(true);
        // A linked worktree's ".git" is a FILE pointing at the host; the Clone's must be its own directory.
        const gitEntries = readdirSync(path.join(clonePath, ".git"));
        expect(gitEntries.length).toBeGreaterThan(0);

        // No host path besides the Clone was ever mounted into the Sandbox —
        // proved through the log, the one place `docker run`'s actual `-v`
        // argument gets recorded (spec, Testing Decisions: "observable from
        // what it leaves ... in ~/.crisol/").
        const log = readFileSync(path.join(runRoot, "log"), "utf8");
        const mountLines = log.split("\n").filter((line) => line.includes("mounts="));
        expect(mountLines).toHaveLength(1);
        expect(mountLines[0]).toContain(`mounts=${clonePath}:${clonePath}`);
        expect(mountLines[0]).not.toContain(repo.path);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "a custom --base and --name are honoured and reported",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        // A second commit on main, so --base can point at the FIRST one.
        Bun.spawnSync(
          ["git", "commit", "--allow-empty", "--quiet", "-m", "chore: second commit"],
          { cwd: repo.path },
        );
        const firstSha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD~1"], {
          cwd: repo.path,
          stdout: "pipe",
        })
          .stdout.toString("utf8")
          .trim();

        const result = await runCli(
          ["run", "say hello", "--json", "--base", firstSha, "--name", "crisol/custom"],
          { cwd: repo.path, home: home.path },
        );

        expect(result.exitCode).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload.branch).toBe("crisol/custom");
        expect(payload.base).toBe(`${firstSha}@${firstSha}`);

        const logText = gitLog(repo.path, "crisol/custom");
        expect(logText).toContain("feat: record the walking-skeleton run");

        // Round-4 review, finding B4: the branch must actually be CUT from
        // firstSha, not merely report it. firstSha is HEAD~1 on the host —
        // if `checkoutNewBranch` ignored `baseSha`, the Clone's default
        // checkout would start from the host's then-current HEAD (the
        // SECOND commit) instead, and this would diverge from firstSha.
        expect(branchParentSha(repo.path, "crisol/custom")).toBe(firstSha);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "run without --json prints a human-readable summary instead of raw JSON",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await runCli(["run", "say hello"], { cwd: repo.path, home: home.path });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(
          /^Run [0-9a-f]{8}: branch crisol\/[0-9a-f]{8}, status unverified\.\n$/,
        );
        expect(() => JSON.parse(result.stdout)).toThrow();
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );
});

/**
 * Round-4 review, finding B4 (real test gap): changing `checkoutNewBranch`
 * (`src/git.ts`) to ignore `baseSha` still passed all 66 tests before this
 * fix — the test above only re-checks the REPORTED `base` string, which is
 * computed independently from `resolveBaseSha`/`baseRef` and never actually
 * observes what `checkoutNewBranch` was called with; `test/base-ref.test.ts`
 * only exercises a tag that already sits on HEAD, where "cut from the tag"
 * and "cut from the Clone's default checkout" are indistinguishable. Both
 * tests below pick a `--base` that is NOT HEAD, so a dropped `baseSha`
 * provably diverges: `checkoutNewBranch`'s own branch point.
 */
describe("the branch is actually CUT from --base, not merely reported (round-4 finding B4)", () => {
  test(
    "--base HEAD~1 — the branch's parent is the commit before HEAD, not HEAD itself",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        Bun.spawnSync(
          ["git", "commit", "--allow-empty", "--quiet", "-m", "chore: second commit"],
          { cwd: repo.path },
        );
        const firstSha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD~1"], {
          cwd: repo.path,
          stdout: "pipe",
        })
          .stdout.toString("utf8")
          .trim();

        const result = await runCli(["run", "say hello", "--json", "--base", "HEAD~1"], {
          cwd: repo.path,
          home: home.path,
        });

        expect(result.exitCode).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(branchParentSha(repo.path, payload.branch)).toBe(firstSha);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "a tag pointing at an OLDER commit, not HEAD — the branch's parent is the tag's commit",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const firstSha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
          cwd: repo.path,
          stdout: "pipe",
        })
          .stdout.toString("utf8")
          .trim();
        Bun.spawnSync(["git", "tag", "v-old"], { cwd: repo.path });
        Bun.spawnSync(
          ["git", "commit", "--allow-empty", "--quiet", "-m", "chore: second commit"],
          { cwd: repo.path },
        );

        const result = await runCli(["run", "say hello", "--json", "--base", "v-old"], {
          cwd: repo.path,
          home: home.path,
        });

        expect(result.exitCode).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload.base).toBe(`v-old@${firstSha}`);
        expect(branchParentSha(repo.path, payload.branch)).toBe(firstSha);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );
});
