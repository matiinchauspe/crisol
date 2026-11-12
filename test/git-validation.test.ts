import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertFetchedBack,
  branchExists,
  checkoutNewBranch,
  cloneLocal,
  fetchBack,
  hasPrefixCollision,
  isValidBranchName,
  readIdentity,
  tagExists,
} from "../src/git";
import { createFixtureRepo } from "./support/fixtureRepo";

/**
 * Pure, fast checks against a real repo, with no Docker involved, so they get their
 * own tight loop before the slower end-to-end `run()`/CLI tests exercise them.
 */
describe("git branch-name validation (W3)", () => {
  test("isValidBranchName rejects a syntactically invalid branch name", () => {
    expect(isValidBranchName("..bad..")).toBe(false);
    expect(isValidBranchName("fine-name")).toBe(true);
  });

  test("branchExists is true for an existing host branch, false otherwise", () => {
    const repo = createFixtureRepo();
    try {
      Bun.spawnSync(["git", "-C", repo.path, "branch", "taken"]);
      expect(branchExists(repo.path, "taken")).toBe(true);
      expect(branchExists(repo.path, "not-taken")).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});

describe("readIdentity (W5: a plain message when identity is missing)", () => {
  test("a repo with no configured user.name/user.email throws a plain, readable message", () => {
    const repo = createFixtureRepo();
    // Unsetting the LOCAL config isn't enough on a dev machine — git falls back to the
    // ambient global `~/.gitconfig`. Isolate from that too.
    const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
    const originalSystem = process.env.GIT_CONFIG_SYSTEM;
    try {
      Bun.spawnSync(["git", "-C", repo.path, "config", "--unset", "user.name"]);
      Bun.spawnSync(["git", "-C", repo.path, "config", "--unset", "user.email"]);
      process.env.GIT_CONFIG_GLOBAL = "/dev/null";
      process.env.GIT_CONFIG_SYSTEM = "/dev/null";
      expect(() => readIdentity(repo.path)).toThrow(/identity/i);
    } finally {
      if (originalGlobal === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = originalGlobal;
      }
      if (originalSystem === undefined) {
        delete process.env.GIT_CONFIG_SYSTEM;
      } else {
        process.env.GIT_CONFIG_SYSTEM = originalSystem;
      }
      repo.cleanup();
    }
  });

  test("a configured identity is read back as-is", () => {
    const repo = createFixtureRepo();
    try {
      expect(readIdentity(repo.path)).toEqual({ name: "Crisol Fixture", email: "fixture@crisol.test" });
    } finally {
      repo.cleanup();
    }
  });
});

/**
 * Reproduced in scratchpad: with a tag AND a branch both named "dup", the old
 * unqualified refspec fetched the TAG's object into the host's `refs/heads/dup` —
 * exit 0, Run's work silently lost.
 */
describe("fetchBack resolves the branch ref even when a same-named tag exists (CRITICAL finding 1)", () => {
  test("the host ends up with the Clone's branch sha, never the tag's", () => {
    const repo = createFixtureRepo(); // acts as the host
    const clonePath = mkdtempSync(path.join(tmpdir(), "crisol-fetchback-clone-"));
    try {
      // A tag "dup" on host HEAD — exactly the ambiguity that broke the old unqualified refspec.
      Bun.spawnSync(["git", "-C", repo.path, "tag", "dup"]);

      const baseSha = Bun.spawnSync(["git", "-C", repo.path, "rev-parse", "HEAD"], {
        stdout: "pipe",
      })
        .stdout.toString("utf8")
        .trim();
      cloneLocal(repo.path, clonePath);
      checkoutNewBranch(clonePath, "dup", baseSha);

      // The Run's actual work: a commit the tag does NOT point at.
      writeFileSync(path.join(clonePath, "agent-work.txt"), "done\n");
      Bun.spawnSync(["git", "-C", clonePath, "add", "agent-work.txt"]);
      Bun.spawnSync(["git", "-C", clonePath, "commit", "--quiet", "-m", "agent work"]);
      const cloneBranchSha = Bun.spawnSync(
        ["git", "-C", clonePath, "rev-parse", "refs/heads/dup"],
        { stdout: "pipe" },
      )
        .stdout.toString("utf8")
        .trim();

      fetchBack(repo.path, clonePath, "dup");

      const hostBranchSha = Bun.spawnSync(
        ["git", "-C", repo.path, "rev-parse", "refs/heads/dup"],
        { stdout: "pipe" },
      )
        .stdout.toString("utf8")
        .trim();
      expect(hostBranchSha).toBe(cloneBranchSha);
    } finally {
      rmSync(clonePath, { recursive: true, force: true });
      repo.cleanup();
    }
  });

});

/** Tested directly here, since forcing git's own `fetch` to misreport success isn't something a test can stage. */
describe("assertFetchedBack (finding 1c: loud failure on a sha mismatch)", () => {
  test("throws naming both shas when they differ", () => {
    expect(() => assertFetchedBack("refs/heads/x", "aaa111", "bbb222")).toThrow(/aaa111/);
    expect(() => assertFetchedBack("refs/heads/x", "aaa111", "bbb222")).toThrow(/bbb222/);
  });

  test("does nothing when they match", () => {
    expect(() => assertFetchedBack("refs/heads/x", "same-sha", "same-sha")).not.toThrow();
  });
});

describe("tagExists (finding 1: pre-check against tag ambiguity)", () => {
  test("is true for an existing host tag, false otherwise", () => {
    const repo = createFixtureRepo();
    try {
      Bun.spawnSync(["git", "-C", repo.path, "tag", "v1.0"]);
      expect(tagExists(repo.path, "v1.0")).toBe(true);
      expect(tagExists(repo.path, "v2.0")).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});

/** A git ref directory/file collision, only caught by git itself at Fetch-back time otherwise — by which point the whole Run has already run for nothing. */
describe("hasPrefixCollision (finding 2: D/F ref collision caught pre-side-effect)", () => {
  test("true when the candidate name is an existing branch's directory prefix", () => {
    const repo = createFixtureRepo();
    try {
      Bun.spawnSync(["git", "-C", repo.path, "branch", "crisol/existing"]);
      expect(hasPrefixCollision(repo.path, "crisol")).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  test("true when the candidate name's directory prefix is an existing branch (the reverse)", () => {
    const repo = createFixtureRepo();
    try {
      Bun.spawnSync(["git", "-C", repo.path, "branch", "crisol"]);
      expect(hasPrefixCollision(repo.path, "crisol/new-run")).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  test("false for unrelated names, and false for the exact same name (branchExists' own job)", () => {
    const repo = createFixtureRepo();
    try {
      Bun.spawnSync(["git", "-C", repo.path, "branch", "crisol/existing"]);
      expect(hasPrefixCollision(repo.path, "unrelated")).toBe(false);
      expect(hasPrefixCollision(repo.path, "crisol/existing")).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});
