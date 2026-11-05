import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "../src/run";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

/**
 * W2: a run id collision must retry with a new id, and must NEVER silently
 * reuse (and truncate) an existing Run dir's files. `generateRunId` is a
 * test seam on `RunOptions`, the same pattern already established for
 * `home`/`adapter`.
 */
describe("Run id collisions never truncate an earlier Run's files (W2)", () => {
  /**
   * finding 4 (round-2 review): the ORIGINAL version of this test reused
   * the same id ("aaaaaaaa") across TWO separate `run()` calls — but by the
   * second call, the first run's Fetch-back had already landed the
   * DEFAULT branch `crisol/aaaaaaaa` in the host repo, so `reserveRun`'s
   * own `branchExists` short-circuit (`continue`, BEFORE `mkdirSync` is
   * ever reached) is what actually forced the retry, not the `mkdirSync`
   * EEXIST catch this test claimed to cover. Here the run dir for
   * "aaaaaaaa" is pre-created by the TEST itself, in a SINGLE `run()` call,
   * before the default branch exists anywhere — so `branchExists` is
   * false and the loop reaches `mkdirSync(runDir("aaaaaaaa"))` directly,
   * which is the EEXIST path actually under test.
   */
  test("a pre-existing run directory forces a retry via mkdir's own EEXIST, not the branch-exists shortcut", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      mkdirSync(path.join(home.path, "runs"), { recursive: true });
      const preexistingDir = path.join(home.path, "runs", "aaaaaaaa");
      mkdirSync(preexistingDir);
      const sentinelPath = path.join(preexistingDir, "sentinel");
      writeFileSync(sentinelPath, "do-not-touch");

      const ids = ["aaaaaaaa", "bbbbbbbb"];
      let call = 0;
      const generateRunId = () => ids[call++]!;

      // A single call: the default branch "crisol/aaaaaaaa" does not exist
      // anywhere yet, so `branchExists` cannot be what forces this retry —
      // only `mkdirSync`'s EEXIST against the dir pre-created above can be.
      const result = await run({ task: "x", cwd: repo.path, home: home.path, generateRunId });

      expect(result.run).toBe("bbbbbbbb");
      expect(readFileSync(sentinelPath, "utf8")).toBe("do-not-touch");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("the default run id is 8 lowercase hex characters, not the spec's 4-char example", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({ task: "x", cwd: repo.path, home: home.path });
      expect(result.run).toMatch(/^[0-9a-f]{8}$/);
      expect(result.branch).toBe(`crisol/${result.run}`);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  /**
   * Round-3 review, finding 1 (CRITICAL): the per-id retry check in
   * `reserveRun` originally only looked at `branchExists` for the
   * GENERATED default branch — never `tagExists`/`hasPrefixCollision` — so
   * a tag (or a D/F prefix collision) sharing the exact `crisol/<id>` name
   * the first generated id would produce was invisible to the retry loop
   * and would have reached Fetch-back's own ref-lookup ambiguity instead
   * (see git-validation.test.ts's "fetchBack resolves the branch ref even
   * when a same-named tag exists" reproduction). `reserveRun` now runs the
   * SAME three checks `assertBranchAvailable` runs for an explicit
   * `--name`, so this id-specific (not the id-INDEPENDENT literal
   * "crisol") collision is retried with a fresh id instead.
   */
  test("a per-id TAG collision on the generated default branch also forces a retry", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      // A TAG — not a branch — named exactly what the FIRST generated id
      // would produce as a default branch.
      Bun.spawnSync(["git", "-C", repo.path, "tag", "crisol/aaaaaaaa"]);

      const ids = ["aaaaaaaa", "bbbbbbbb"];
      let call = 0;
      const generateRunId = () => ids[call++]!;

      const result = await run({ task: "x", cwd: repo.path, home: home.path, generateRunId });

      expect(result.run).toBe("bbbbbbbb");
      expect(result.branch).toBe("crisol/bbbbbbbb");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});
