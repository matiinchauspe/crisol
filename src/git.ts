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
  // `env: process.env` is explicit on purpose: `Bun.spawnSync` without an
  // `env` option inherits the snapshot from when THIS process started, not
  // live mutations made to `process.env` afterwards (a real gotcha a test
  // seam can trip over in-process, e.g. `GIT_CONFIG_GLOBAL`).
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

/** The host git repo's root for `cwd` — `crisol run` must be invoked from inside one. `undefined`, never a throw, when it isn't. */
export function discoverGitRoot(cwd: string): string | undefined {
  const result = run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

/** `HEAD` on a detached checkout, the branch name otherwise — what the spec's `base` field names before the `@<sha>` when no `--base` is given. */
export function currentRefName(repoPath: string): string {
  return runOrThrow(["git", "-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]);
}

export function shortSha(repoPath: string, ref: string): string {
  return runOrThrow(["git", "-C", repoPath, "rev-parse", "--short", ref]);
}

/**
 * The host identity Crisol passes into the Sandbox as `GIT_AUTHOR_*` /
 * `GIT_COMMITTER_*` env (spec, "Commits" q16) — never a mounted
 * `~/.gitconfig`, so this is the only way the agent's commits carry the
 * human's name and email.
 *
 * Validated with a plain message (fix W5) rather than raw git stderr — this
 * is checked before any side effect, so the message is the FIRST thing a
 * developer with a half-configured repo sees.
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

/**
 * `git check-ref-format --branch <name>` — the exact syntax check git
 * itself performs before creating a branch (fix W3), run here BEFORE any
 * side effect so an invalid `--name` never costs a Clone.
 */
export function isValidBranchName(name: string): boolean {
  return run(["git", "check-ref-format", "--branch", name]).exitCode === 0;
}

/**
 * Whether `refs/heads/<name>` already exists in the HOST repo (fix W3) —
 * checked before any Clone exists, so a collision never costs a Clone or a
 * container either.
 */
export function branchExists(hostRepoPath: string, name: string): boolean {
  return (
    run(["git", "-C", hostRepoPath, "show-ref", "--verify", "--quiet", `refs/heads/${name}`])
      .exitCode === 0
  );
}

/**
 * Whether `refs/tags/<name>` already exists in the HOST repo (round-2
 * review, finding 1: a `--name` that collides with an existing tag made the
 * OLD unqualified Fetch-back refspec silently resolve to the tag's object
 * instead of the Run's own branch). Checked before any Clone exists, same
 * as `branchExists` — a tag-colliding name is refused up front rather than
 * relying solely on `fetchBack`'s own fully-qualified refspec and
 * post-fetch verification to save it.
 */
export function tagExists(hostRepoPath: string, name: string): boolean {
  return (
    run(["git", "-C", hostRepoPath, "show-ref", "--verify", "--quiet", `refs/tags/${name}`])
      .exitCode === 0
  );
}

/**
 * Whether creating `refs/heads/<name>` in the HOST repo would collide with
 * an existing branch by directory/file conflict (round-2 review, finding 2:
 * `--name crisol` while `crisol/<id>` exists, or the reverse). Git's ref
 * storage is a filesystem tree under `.git/refs/heads` — a ref can never be
 * BOTH a leaf and a directory, and without this check the collision is only
 * caught by git itself at Fetch-back time (`cannot lock ref
 * 'refs/heads/crisol': 'refs/heads/crisol/existing' exists`), by which
 * point the whole Run already happened for nothing. Checked before any
 * Clone exists, same as `branchExists`/`tagExists`.
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
 * `git clone --no-local file://<hostRepoPath>` (spec, "Workspace — local
 * Clone + Fetch-back" q2, amended 2026-11-05 — see crisol ADR 0004's second
 * amendment): a Clone with its OWN `.git` — never a worktree, which would
 * share the host's refs and let an unattended agent rewrite them — AND
 * holding ONLY the objects reachable from some ref, never the host's
 * unreachable/dangling ones.
 *
 * `--no-local` (forced by the explicit `file://` URL, which disables the
 * filesystem fast-path even for a local path) is load-bearing: the earlier
 * fix, `--local --no-hardlinks`, still performed git's filesystem-clone
 * optimization, which copies the WHOLE `.git/objects/` directory wholesale
 * — dangling objects included. A secret that was `git add`ed, `git
 * stash`ed, and later `git stash drop`ped is unreachable from any ref (`git
 * log --all` never mentions it) but stays physically in the host's object
 * store until a `git gc` runs — and `--local --no-hardlinks` copied it into
 * every Clone anyway, readable from inside the Sandbox via `git cat-file`.
 * `--no-local` forces git's normal transport negotiation, which only ever
 * walks and transfers objects reachable from a ref — dangling objects never
 * cross. This costs more packing time per Run than the filesystem fast-path
 * did; that is the price of the Clone never seeing what the host dropped.
 */
export function cloneLocal(hostRepoPath: string, clonePath: string): void {
  runOrThrow(["git", "clone", "--no-local", "--quiet", `file://${hostRepoPath}`, clonePath]);
}

/** Cuts `name` from `baseSha` inside the Clone, before the Sandbox ever starts. */
export function checkoutNewBranch(clonePath: string, name: string, baseSha: string): void {
  runOrThrow(["git", "-C", clonePath, "checkout", "--quiet", "-b", name, baseSha]);
}

/**
 * Throws when Fetch-back's own post-fetch verification fails (finding 1c):
 * the host's `<ref>` must end up at exactly the Clone's sha, or the Run's
 * work may not have actually been brought back despite `git fetch`
 * exiting 0. Exported and tested on its own, since forcing git's real
 * `fetch` to misreport success is not something a test can stage.
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
 * The host-side `git fetch <clone> refs/heads/<name>:refs/heads/<name>`
 * (spec, "Fetch-back") — the only way the Run's branch ever reaches the
 * host repo, since the agent itself has no access to the host's refs.
 *
 * CRITICAL fix (round-2 review, finding 1): the refspec is fully qualified
 * on BOTH sides. The old `<name>:<name>` was unqualified, and git's own
 * ref-lookup order checks `refs/tags/` before `refs/heads/` for a short,
 * ambiguous name — so a `--name` equal to an existing host tag silently
 * fetched the TAG's (old) object instead of the Clone's branch (the Run's
 * actual work) and exited 0, losing the Run's work with no error at all.
 * Qualifying both sides pins the fetch to the branch regardless of what
 * else in the Clone or the host shares that name.
 *
 * After the fetch, the host's `<ref>` sha is verified against the Clone's
 * own — see `assertFetchedBack` — so a Fetch-back that technically
 * "succeeded" (exit 0) but landed the wrong object is never reported as a
 * success.
 *
 * No `--quiet`: fix W3 requires git's own stderr to surface on failure
 * (`runOrThrow` already includes it in the thrown message) rather than be
 * swallowed by quiet mode.
 */
export function fetchBack(hostRepoPath: string, clonePath: string, name: string): void {
  const ref = `refs/heads/${name}`;
  runOrThrow(["git", "-C", hostRepoPath, "fetch", clonePath, `${ref}:${ref}`]);
  const cloneSha = runOrThrow(["git", "-C", clonePath, "rev-parse", ref]);
  const hostSha = runOrThrow(["git", "-C", hostRepoPath, "rev-parse", ref]);
  assertFetchedBack(ref, hostSha, cloneSha);
}

/**
 * Whether `sha` is reachable from one of the refs `cloneLocal` actually
 * transfers: a local branch, a tag, or HEAD (round-3 review, finding 4,
 * WARNING, narrowed by round-4 review, finding C1, WARNING).
 *
 * `resolveBaseSha` only checks that `sha` EXISTS (`rev-parse
 * <ref>^{commit}`) — a sha that is still physically in the object store but
 * reachable from nothing a Clone would ever see (e.g. the tip of a branch
 * that was since force-deleted, before any `git gc`) happily passes that
 * check.
 *
 * Finding C1: this used to be `git for-each-ref --contains <sha>` with NO
 * pattern, which lists refs under ALL of `refs/` — `refs/remotes/*`,
 * `refs/stash`, notes, everything. `cloneLocal`'s `--no-local file://`
 * transport (ADR 0004's second amendment) never walks any of those: a
 * remote-tracking ref is a purely local bookkeeping concept the host never
 * advertises to a clone, and a stash entry is reachable from nothing
 * negotiated either. That mismatch cut both ways — a `--base origin/main`
 * ahead of every local branch, or a stash sha, used to pass THIS check and
 * then fail much later inside `checkoutNewBranch` with git's own
 * misleading "is not a commit" (plus a noisy Fetch-back error on top),
 * after the run dir and the Clone had already been created; and in
 * reverse, a brand-new commit on a DETACHED HEAD — named by nothing under
 * `refs/` yet — was wrongly refused here even though the Clone genuinely
 * carries it, since HEAD (detached or not) is one of the refs git's own
 * clone negotiation always walks.
 *
 * Fixed by narrowing the check to exactly what the Clone receives, rather
 * than widening what the Clone receives to match the old check — the
 * simpler of the two, and one that leaves `cloneLocal` and ADR 0004
 * untouched. `git for-each-ref --contains <sha> refs/heads/ refs/tags/`
 * covers the first two; `git merge-base --is-ancestor <sha> HEAD` covers
 * HEAD even when there's no ref under `refs/` to list it by (and, being
 * reflexive, also matches `sha` being HEAD's own tip exactly).
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
 * Resolves `ref` to the short sha of the COMMIT it names — `ref^{commit}`
 * peels an annotated tag down to its target commit (an annotated tag is
 * its own object, distinct from the commit it points at); a branch, a
 * lightweight tag, or a raw sha already IS a commit, so the peel is a
 * no-op for those. Required so `--base <annotated tag>` reports and checks
 * out the commit, never the tag object's own sha.
 */
export function resolveBaseSha(repoPath: string, ref: string): string {
  return shortSha(repoPath, `${ref}^{commit}`);
}
