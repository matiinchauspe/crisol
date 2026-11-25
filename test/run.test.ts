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
 * The sha the branch was actually CUT from: the FakeAdapter's `DEFAULT_SCRIPT` makes
 * exactly one commit on top of the branch's starting point, so `<branch>~1` is that
 * point — the branch's PARENT, not its tip. Proves `checkoutNewBranch` was actually
 * called with `baseSha`, not just that the reported `base` string says so.
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
        const result = await runCli(["run", "say hello", "--json", "--adapter", "fake"], {
          cwd: repo.path,
          home: home.path,
        });

        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
        const payload = JSON.parse(result.stdout);

        expect(payload).toMatchObject({
          status: "unverified",
          iterations: 1,
          gates: [],
          network: "allowlist",
          blocked: [],
          warnings: [],
        });
        expect(typeof payload.run).toBe("string");
        expect(payload.run).toMatch(/^[0-9a-f]{8}$/);
        expect(payload.branch).toBe(`crisol/${payload.run}`);
        expect(payload.base).toMatch(/^main@[0-9a-f]+$/);

        const logText = gitLog(repo.path, payload.branch);
        expect(logText).toContain("feat: record the walking-skeleton run");

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

        // No host path besides the Clone was ever mounted — proved through the log, the
        // one place `docker run`'s actual mount argument gets recorded.
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
          ["run", "say hello", "--json", "--base", firstSha, "--name", "crisol/custom", "--adapter", "fake"],
          { cwd: repo.path, home: home.path },
        );

        expect(result.exitCode).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload.branch).toBe("crisol/custom");
        expect(payload.base).toBe(`${firstSha}@${firstSha}`);

        const logText = gitLog(repo.path, "crisol/custom");
        expect(logText).toContain("feat: record the walking-skeleton run");

        // If `checkoutNewBranch` ignored `baseSha`, the Clone would start from the host's
        // current HEAD (the SECOND commit) instead, diverging from firstSha.
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
        const result = await runCli(["run", "say hello", "--adapter", "fake"], { cwd: repo.path, home: home.path });

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
 * The above tests only re-check the REPORTED `base` string, never observing what
 * `checkoutNewBranch` was actually called with — and `base-ref.test.ts` only exercises a
 * tag already on HEAD, where "cut from the tag" and "cut from the default checkout" are
 * indistinguishable. Both tests below pick a `--base` that is NOT HEAD, so a dropped
 * `baseSha` provably diverges.
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

        const result = await runCli(["run", "say hello", "--json", "--base", "HEAD~1", "--adapter", "fake"], {
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

        const result = await runCli(["run", "say hello", "--json", "--base", "v-old", "--adapter", "fake"], {
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
