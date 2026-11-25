import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SCRIPT, FakeAdapter, WIDEN_REPO_LEVEL_SCRIPT } from "../src/adapters/fake";
import { discoverGitRoot } from "../src/git";
import { runRepoPath, runResultPath } from "../src/paths";
import { run } from "../src/run";
import type { RunResult } from "../src/run";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { onlyRunId, readLog, refSha } from "./support/runState";

function git(repoPath: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString("utf8")}`);
  return proc.stdout.toString("utf8").trim();
}

function tagNames(repoPath: string): string[] {
  return git(repoPath, ["for-each-ref", "--format=%(refname)", "refs/tags/"]).split("\n").filter(Boolean);
}

/**
 * A dir only the host has: the Sandbox mounts nothing but the Clone, so a marker that appears here
 * was written by a process on the host.
 */
function createMarkerDir(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), "crisol-host-marker-"));
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Inside the Sandbox this dir does not exist, so only a host-side run leaves the touched file. */
function payload(file: string, markers: string, name: string, tail: string): string {
  return `printf '#!/bin/sh\\ntouch ${markers}/${name}\\n${tail}\\n' > ${file} && chmod +x ${file}`;
}

/**
 * Commits a change to `.crisol/network` (so the host diffs it) and a commit carrying a gpgsig
 * header (so `log.showSignature` has a signature to verify), leaves HEAD off the Run's branch (so
 * a Continuation has to check it out again), then plants every executable hook into `.git`.
 */
function plantingScript(markers: string): string[] {
  return [
    ...WIDEN_REPO_LEVEL_SCRIPT,
    "c=$(printf 'tree %s\\nparent %s\\nauthor %s <%s> 1700000000 +0000\\ncommitter %s <%s> 1700000000 +0000\\n" +
      "gpgsig -----BEGIN PGP SIGNATURE-----\\n \\n iQ\\n -----END PGP SIGNATURE-----\\n\\nfeat: a signed commit\\n' " +
      '"$(git rev-parse HEAD^{tree})" "$(git rev-parse HEAD)" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" ' +
      '"$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL" | git hash-object -t commit -w --stdin) && git update-ref HEAD "$c"',
    "git checkout --quiet -b elsewhere",
    payload(".git/hooks/post-checkout", markers, "post-checkout", "exit 0"),
    payload(".git/textconv", markers, "textconv", 'cat \\"$1\\"'),
    'git config diff.evil.textconv "$PWD/.git/textconv"',
    "mkdir -p .git/info && echo '* diff=evil' >> .git/info/attributes",
    payload(".git/gpg", markers, "gpg", "exit 1"),
    'git config log.showSignature true && git config gpg.program "$PWD/.git/gpg"',
    payload(".git/fsmonitor", markers, "fsmonitor", "exit 1"),
    'git config core.fsmonitor "$PWD/.git/fsmonitor"',
  ];
}

const REVIEW_SCRIPT: readonly string[] = [
  "echo 'review applied' > REVIEW.md",
  "git add REVIEW.md",
  "git commit --quiet -m 'fix: apply the review'",
];

describe("host git never runs what an agent wrote into the Clone's .git", () => {
  test(
    "a textconv driver, a post-checkout hook, log.showSignature with gpg.program and core.fsmonitor stay inert across a Run and a Continuation",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      const markers = createMarkerDir();
      try {
        const first = await run({
          task: "x",
          cwd: repo.path,
          home: home.path,
          name: "feature/hostile",
          // The script leaves HEAD off the branch and a Run with no Gates resumes on that; one
          // iteration stops at the ceiling with HEAD still off for the Continuation.
          maxIterations: 1,
          adapter: new FakeAdapter(plantingScript(markers.path), undefined, undefined, {}, { store: "/crisol-fake-sessions" }),
        });
        expect(first.fetchBack).toBe(true);
        expect(readdirSync(markers.path)).toEqual([]);
        // The scan still reads the branch: the Allowlist change it was planted beside is flagged.
        expect(first.warnings.some((entry) => entry.includes(".crisol/network"))).toBe(true);

        const continued = await run({
          task: "apply the review",
          cwd: repo.path,
          home: home.path,
          continue: "feature/hostile",
          adapter: new FakeAdapter(DEFAULT_SCRIPT, undefined, undefined, {}, {
            store: "/crisol-fake-sessions",
            continueScript: REVIEW_SCRIPT,
          }),
        });
        expect(continued.fetchBack).toBe(true);
        expect(git(repo.path, ["log", "-1", "--format=%s", "refs/heads/feature/hostile"])).toBe("fix: apply the review");
        expect(readdirSync(markers.path)).toEqual([]);
      } finally {
        markers.cleanup();
        home.cleanup();
        repo.cleanup();
      }
    },
    180_000,
  );

  test("a Clone whose .git became a gitfile is refused before any host git call, and the Run says so", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const host = discoverGitRoot(repo.path)!;
      const refsBefore = git(host, ["for-each-ref"]);
      const repoint = [...DEFAULT_SCRIPT, `mv .git .git-moved && printf 'gitdir: %s/.git\\n' '${host}' > .git`];

      let failure: unknown;
      try {
        await run({ task: "x", cwd: repo.path, home: home.path, maxIterations: 1, adapter: new FakeAdapter(repoint) });
      } catch (error) {
        failure = error;
      }

      expect(String(failure)).toContain(".git is no longer a directory");
      const id = onlyRunId(home.path);
      expect(readLog(id, home.path)).toContain(".git is no longer a directory");
      expect(git(host, ["for-each-ref"])).toBe(refsBefore);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 90_000);
});

describe("Fetch-back brings back exactly one ref", () => {
  test("an annotated tag made in the Clone reaches the host neither at Fetch-back nor at recover", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({
        task: "x",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter([...DEFAULT_SCRIPT, "git tag -a v9.9.9 -m 'release'"]),
      });
      expect(result.fetchBack).toBe(true);
      expect(tagNames(repo.path)).toEqual([]);

      // What recover acts on: a Run whose own Fetch-back failed (`run()` then writes `fetchBack:
      // false`), its Clone holding a tagged commit the host lacks.
      const resultPath = runResultPath(result.run, home.path);
      const written = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
      writeFileSync(resultPath, JSON.stringify({ ...written, fetchBack: false }, null, 2));
      const clone = runRepoPath(result.run, home.path);
      git(clone, ["commit", "--quiet", "--allow-empty", "-m", "late"]);
      git(clone, ["tag", "-a", "v9.9.10", "-m", "release"]);
      const ahead = git(clone, ["rev-parse", `refs/heads/${result.branch}`]);

      const recovered = await runCli(["recover"], { cwd: repo.path, home: home.path });
      expect(recovered.exitCode).toBe(0);
      expect(refSha(repo.path, result.branch)).toBe(ahead);
      expect(tagNames(repo.path)).toEqual([]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 90_000);
});

describe("the commit and Allowlist scans read the branch, never a same-named tag", () => {
  test("a tag named after the branch, at the base, still leaves both warnings raised", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({
        task: "x",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter([
          'git tag "$(git rev-parse --abbrev-ref HEAD)"',
          ...WIDEN_REPO_LEVEL_SCRIPT,
          'echo more >> CRISOL_RUN.md && git add CRISOL_RUN.md && git commit --quiet -m "feat: more" -m "Co-Authored-By: Claude <noreply@anthropic.com>"',
        ]),
      });
      expect(result.warnings.some((entry) => entry.includes("attribution"))).toBe(true);
      expect(result.warnings.some((entry) => entry.includes(".crisol/network"))).toBe(true);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 90_000);
});
