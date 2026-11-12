import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { runCli } from "./support/cli";

describe("--base <annotated tag> resolves and checks out the TARGET commit (tag)", () => {
  test("base reports the commit sha, not the tag object's own sha, and the branch is cut from the commit", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const commitSha = Bun.spawnSync(["git", "-C", repo.path, "rev-parse", "--short", "HEAD"], {
        stdout: "pipe",
      })
        .stdout.toString("utf8")
        .trim();
      const tagObjectSha = Bun.spawnSync(
        ["git", "-C", repo.path, "tag", "-a", "v1.0", "-m", "v1.0"],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(tagObjectSha.exitCode).toBe(0);
      const tagSha = Bun.spawnSync(["git", "-C", repo.path, "rev-parse", "--short", "v1.0"], {
        stdout: "pipe",
      })
        .stdout.toString("utf8")
        .trim();
      // An annotated tag's OWN object sha differs from the commit it targets.
      expect(tagSha).not.toBe(commitSha);

      const result = await runCli(["run", "say hello", "--json", "--base", "v1.0"], {
        cwd: repo.path,
        home: home.path,
      });

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.base).toBe(`v1.0@${commitSha}`);

      // The branch's parent is exactly the tag's target COMMIT, not the tag object.
      const parentSha = Bun.spawnSync(
        ["git", "-C", repo.path, "log", "--format=%h", "-1", `${payload.branch}~1`],
        { stdout: "pipe" },
      )
        .stdout.toString("utf8")
        .trim();
      expect(parentSha).toBe(commitSha);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

/**
 * A commit on a DETACHED HEAD has no branch or tag naming it yet, so the old
 * reachability check wrongly refused the default base even though the Clone actually
 * carries it via HEAD. Regression test for checking ancestry against HEAD directly.
 */
describe("detached HEAD with a new commit, no --base (round-4 finding C1)", () => {
  test("the default base (HEAD) is accepted end to end — the Clone carries it via HEAD even detached", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      Bun.spawnSync(["git", "-C", repo.path, "checkout", "--quiet", "--detach", "HEAD"]);
      writeFileSync(`${repo.path}/detached.txt`, "new work\n");
      Bun.spawnSync(["git", "-C", repo.path, "add", "detached.txt"]);
      Bun.spawnSync(["git", "-C", repo.path, "commit", "--quiet", "-m", "chore: detached commit"]);
      const detachedSha = Bun.spawnSync(["git", "-C", repo.path, "rev-parse", "--short", "HEAD"], {
        stdout: "pipe",
      })
        .stdout.toString("utf8")
        .trim();

      const result = await runCli(["run", "say hello", "--json"], {
        cwd: repo.path,
        home: home.path,
      });

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.base).toBe(`HEAD@${detachedSha}`);

      // Proves the Clone actually carried the commit via HEAD, not merely that the
      // pre-check let it through.
      const parentSha = Bun.spawnSync(
        ["git", "-C", repo.path, "log", "--format=%h", "-1", `${payload.branch}~1`],
        { stdout: "pipe" },
      )
        .stdout.toString("utf8")
        .trim();
      expect(parentSha).toBe(detachedSha);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});
