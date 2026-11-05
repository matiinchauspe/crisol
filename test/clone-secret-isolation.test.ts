import { describe, expect, test } from "bun:test";
import { run } from "../src/run";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { runRepoPath } from "../src/paths";

/**
 * New decision #1655 (amends crisol ADR 0004 a second time): the Clone must
 * copy REACHABLE objects only. The round-1 fix (`git clone --local
 * --no-hardlinks`) still used git's filesystem-clone fast path, which
 * copies the WHOLE `.git/objects/` directory wholesale — dangling objects
 * included. A secret that was `git add`ed, `git stash`ed, and later `git
 * stash drop`ped is unreachable from any ref (`git log --all` never
 * mentions it) but stays physically in the host's object store until a
 * `git gc` runs; reproduced in scratchpad, the `--local` Clone could still
 * `git cat-file` it. `--no-local file://<path>` forces git's normal
 * transport negotiation even for a local path, which only ever walks and
 * transfers objects reachable from a ref.
 */
describe("Clone copies reachable objects only, never dangling ones (finding 9 / #1655)", () => {
  test("a secret that was staged, stashed, then dropped is unreadable inside the Clone", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      await Bun.write(`${repo.path}/.env`, "SECRET=abc123\n");
      Bun.spawnSync(["git", "-C", repo.path, "add", ".env"]);
      const stashResult = Bun.spawnSync(
        ["git", "-C", repo.path, "stash", "push", "--quiet", "-m", "wip secret"],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(stashResult.exitCode).toBe(0);

      const blobSha = Bun.spawnSync(
        ["git", "-C", repo.path, "ls-tree", "stash@{0}", "--", ".env"],
        { stdout: "pipe" },
      )
        .stdout.toString("utf8")
        .trim()
        .split(/\s+/)[2]!;
      expect(blobSha).toHaveLength(40);

      Bun.spawnSync(["git", "-C", repo.path, "stash", "drop", "--quiet"]);

      // Sanity: unreachable from any ref, but still physically present on
      // the HOST until a `git gc` runs — proves the setup actually
      // reproduces the dangerous case, not an already-absent object.
      const stillOnHost = Bun.spawnSync(["git", "-C", repo.path, "cat-file", "-p", blobSha], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(stillOnHost.exitCode).toBe(0);
      expect(Bun.spawnSync(["git", "-C", repo.path, "log", "--all", "--oneline"], { stdout: "pipe" })
        .stdout.toString("utf8")).not.toContain(blobSha.slice(0, 7));

      const result = await run({ task: "x", cwd: repo.path, home: home.path });

      const clonePath = runRepoPath(result.run, home.path);
      const insideClone = Bun.spawnSync(["git", "-C", clonePath, "cat-file", "-p", blobSha], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(insideClone.exitCode).not.toBe(0);
      expect(insideClone.stderr.toString("utf8")).toContain("Not a valid object name");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});
