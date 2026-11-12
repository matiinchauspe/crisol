import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "../src/run";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

/**
 * A run id collision must retry with a new id, never silently reuse (and truncate) an
 * existing Run dir's files. `generateRunId` is a test seam, same pattern as `home`/`adapter`.
 */
describe("Run id collisions never truncate an earlier Run's files (W2)", () => {
  /**
   * The ORIGINAL version of this test called `run()` TWICE with the same id — but by the
   * second call, Fetch-back had already landed the default branch, so `branchExists`'s own
   * short-circuit forced the retry, never actually exercising `mkdirSync`'s EEXIST path.
   * Here the run dir is pre-created by the TEST itself, in a SINGLE `run()` call, before the
   * default branch exists anywhere — so the EEXIST path is what's actually under test.
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

      // Only `mkdirSync`'s EEXIST can force this retry — the default branch doesn't exist yet.
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
   * A tag sharing the exact `crisol/<id>` name the generated id would produce used to be
   * invisible to the retry loop (it only checked `branchExists`), reaching Fetch-back's
   * own ref-lookup ambiguity instead.
   */
  test("a per-id TAG collision on the generated default branch also forces a retry", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      // A TAG, not a branch, named exactly what the FIRST generated id would produce.
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
