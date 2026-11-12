export interface GitIdentity {
  name: string;
  email: string;
}

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd?: string): ShellResult {
  // `env: process.env` explicit: without it, `Bun.spawnSync` inherits the snapshot
  // from process start, not live mutations (a gotcha test seams can trip over, e.g.
  // `GIT_CONFIG_GLOBAL`).
  const proc = Bun.spawnSync(args, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString("utf8"),
    stderr: proc.stderr.toString("utf8"),
  };
}

function runOrThrow(args: string[], cwd?: string): string {
  const result = run(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${args.join(" ")}\` failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

/** `undefined`, never a throw, when `cwd` isn't inside a git repo. */
export function discoverGitRoot(cwd: string): string | undefined {
  const result = run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

/** `HEAD` on a detached checkout, the branch name otherwise. */
export function currentRefName(repoPath: string): string {
  return runOrThrow(["git", "-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]);
}

export function shortSha(repoPath: string, ref: string): string {
  return runOrThrow(["git", "-C", repoPath, "rev-parse", "--short", ref]);
}

/**
 * Passed into the Sandbox as `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env — never a mounted
 * `~/.gitconfig`, so this is the only way the agent's commits carry the human's name
 * and email. Checked before any side effect, so a half-configured repo surfaces this
 * plain message first.
 */
export function readIdentity(repoPath: string): GitIdentity {
  const name = run(["git", "-C", repoPath, "config", "user.name"]);
  const email = run(["git", "-C", repoPath, "config", "user.email"]);
  const nameValue = name.exitCode === 0 ? name.stdout.trim() : "";
  const emailValue = email.exitCode === 0 ? email.stdout.trim() : "";
  if (!nameValue || !emailValue) {
    throw new Error(
      `Git identity is not configured for ${repoPath}. Run ` +
        `\`git config user.name "<name>"\` and \`git config user.email "<email>"\` first.`,
    );
  }
  return { name: nameValue, email: emailValue };
}

/** Run before any side effect, so an invalid `--name` never costs a Clone. */
export function isValidBranchName(name: string): boolean {
  return run(["git", "check-ref-format", "--branch", name]).exitCode === 0;
}

/** Checked before any Clone exists, so a collision never costs a Clone or a container. */
export function branchExists(hostRepoPath: string, name: string): boolean {
  return (
    run(["git", "-C", hostRepoPath, "show-ref", "--verify", "--quiet", `refs/heads/${name}`])
      .exitCode === 0
  );
}

/**
 * A name colliding with an existing tag made the OLD unqualified Fetch-back refspec
 * silently resolve to the tag's object instead of the Run's branch. Checked before any
 * Clone exists — refused up front rather than relying solely on `fetchBack`'s own
 * fully-qualified refspec and post-fetch verification to catch it.
 */
export function tagExists(hostRepoPath: string, name: string): boolean {
  return (
    run(["git", "-C", hostRepoPath, "show-ref", "--verify", "--quiet", `refs/tags/${name}`])
      .exitCode === 0
  );
}

/**
 * Git's ref storage is a filesystem tree under `.git/refs/heads` — a ref can never be
 * both a leaf and a directory (e.g. `crisol` vs `crisol/<id>`). Without this check the
 * collision is only caught by git itself at Fetch-back time, after the whole Run already
 * happened for nothing.
 */
export function hasPrefixCollision(hostRepoPath: string, name: string): boolean {
  const existing = run([
    "git",
    "-C",
    hostRepoPath,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  return existing.some((ref) => ref !== name && (ref.startsWith(`${name}/`) || name.startsWith(`${ref}/`)));
}

/**
 * `git clone --no-local file://<hostRepoPath>`: a Clone with its own `.git` — never a
 * worktree, which would share the host's refs and let an unattended agent rewrite them —
 * holding only objects reachable from some ref, never the host's dangling ones.
 *
 * `--no-local` is load-bearing: an earlier `--local --no-hardlinks` still used git's
 * filesystem-clone fast path, which copies the WHOLE `.git/objects/` directory wholesale,
 * dangling objects included. A secret that was staged and later `git stash drop`ped is
 * unreachable from any ref but stays physically in the host's object store until `git gc`
 * runs — and the fast path copied it into every Clone anyway, readable via `git cat-file`.
 * `--no-local` forces git's normal transport negotiation, which only walks objects
 * reachable from a ref, at the cost of more packing time per Run.
 */
export function cloneLocal(hostRepoPath: string, clonePath: string): void {
  runOrThrow(["git", "clone", "--no-local", "--quiet", `file://${hostRepoPath}`, clonePath]);
}

/** Cuts `name` from `baseSha` inside the Clone, before the Sandbox ever starts. */
export function checkoutNewBranch(clonePath: string, name: string, baseSha: string): void {
  runOrThrow(["git", "-C", clonePath, "checkout", "--quiet", "-b", name, baseSha]);
}

/**
 * Host `<ref>` must land at exactly the Clone's sha — `git fetch` can exit 0 without
 * actually having brought back the right object. Exported and tested on its own, since
 * forcing git itself to misreport success isn't something a test can stage.
 */
export function assertFetchedBack(ref: string, hostSha: string, cloneSha: string): void {
  if (hostSha !== cloneSha) {
    throw new Error(
      `Fetch-back verification failed for ${ref}: host is at ${hostSha} but the Clone's is ` +
        `${cloneSha}. The Run's work may not have been brought back correctly.`,
    );
  }
}

/**
 * The host-side `git fetch <clone> refs/heads/<name>:refs/heads/<name>` — the only way
 * the Run's branch reaches the host repo, since the agent has no access to the host's refs.
 *
 * The refspec is fully qualified on BOTH sides. An unqualified `<name>:<name>` let git's
 * own ref-lookup order (tags before heads) silently fetch an existing tag's object instead
 * of the Clone's branch for a colliding name, exiting 0 with the Run's work lost and no
 * error at all. Qualifying both sides pins the fetch to the branch regardless of what else
 * shares that name.
 *
 * No `--quiet`: git's own stderr must surface on failure (`runOrThrow` includes it in the
 * thrown message) rather than be swallowed by quiet mode.
 */
export function fetchBack(hostRepoPath: string, clonePath: string, name: string): void {
  const ref = `refs/heads/${name}`;
  runOrThrow(["git", "-C", hostRepoPath, "fetch", clonePath, `${ref}:${ref}`]);
  const cloneSha = runOrThrow(["git", "-C", clonePath, "rev-parse", ref]);
  const hostSha = runOrThrow(["git", "-C", hostRepoPath, "rev-parse", ref]);
  assertFetchedBack(ref, hostSha, cloneSha);
}

/**
 * Whether `sha` is reachable from a ref `cloneLocal` actually transfers: a local branch,
 * a tag, or HEAD. `resolveBaseSha` only checks that `sha` EXISTS — a sha still physically
 * in the object store but reachable from nothing a Clone would ever see (e.g. a
 * force-deleted branch tip, before `git gc`) passes that check anyway.
 *
 * This used to be `git for-each-ref --contains <sha>` with no pattern, matching refs under
 * ALL of `refs/` — remote-tracking refs, stashes, notes — none of which `cloneLocal`'s
 * `file://` transport actually walks. That let a `--base` ahead of every local branch (or a
 * stash sha) pass here and fail much later inside `checkoutNewBranch`, after the Clone
 * already existed; and in reverse, wrongly refused a brand-new commit on a detached HEAD,
 * since HEAD carries nothing under `refs/` to be listed by.
 *
 * Narrowed instead of widening what the Clone receives: `for-each-ref --contains <sha>
 * refs/heads/ refs/tags/` covers branches and tags; `merge-base --is-ancestor <sha> HEAD`
 * covers HEAD even with no ref under `refs/` naming it.
 */
export function isReachableFromClonedRefs(repoPath: string, sha: string): boolean {
  const fromBranchOrTag =
    run([
      "git",
      "-C",
      repoPath,
      "for-each-ref",
      "--contains",
      sha,
      "refs/heads/",
      "refs/tags/",
    ]).stdout.trim().length > 0;
  if (fromBranchOrTag) return true;
  return run(["git", "-C", repoPath, "merge-base", "--is-ancestor", sha, "HEAD"]).exitCode === 0;
}

/**
 * `ref^{commit}` peels an annotated tag down to its target commit (an annotated tag is
 * its own object, distinct from the commit it points at); a no-op for a branch, a
 * lightweight tag, or a raw sha. Needed so `--base <annotated tag>` resolves to the
 * commit, never the tag object's own sha.
 */
export function resolveBaseSha(repoPath: string, ref: string): string {
  return shortSha(repoPath, `${ref}^{commit}`);
}
