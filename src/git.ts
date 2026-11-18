export interface GitIdentity {
  name: string;
  email: string;
}

interface ShellResult {
  exitCode: number | null;
  /** Set when the process was killed by a signal rather than exiting. */
  signal?: string;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd?: string): ShellResult {
  const proc = Bun.spawnSync(args, {
    cwd,
    // Without it, `Bun.spawnSync` sees the env as it was at process start, not later mutations.
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    // Its own session: a Ctrl+C or hang-up aimed at Crisol's process group must not kill a
    // Clone or a Fetch-back half way. Crisol's own handlers decide what a signal stops.
    detached: true,
  });
  return {
    exitCode: proc.exitCode,
    signal: proc.signalCode === undefined || proc.signalCode === null ? undefined : String(proc.signalCode),
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

/** The only way the agent's commits carry the human's name: no `~/.gitconfig` is mounted. */
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

export function isValidBranchName(name: string): boolean {
  return run(["git", "check-ref-format", "--branch", name]).exitCode === 0;
}

export function branchExists(hostRepoPath: string, name: string): boolean {
  return (
    run(["git", "-C", hostRepoPath, "show-ref", "--verify", "--quiet", `refs/heads/${name}`])
      .exitCode === 0
  );
}

export function tagExists(hostRepoPath: string, name: string): boolean {
  return (
    run(["git", "-C", hostRepoPath, "show-ref", "--verify", "--quiet", `refs/tags/${name}`])
      .exitCode === 0
  );
}

/** A ref cannot be both a leaf and a directory (`crisol` vs `crisol/<id>`); git would only refuse it at Fetch-back. */
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
 * Its own `.git`, never a worktree, which would let an unattended agent rewrite host refs.
 * `--no-local` forces transport negotiation, so only objects reachable from a ref cross over:
 * git's filesystem fast path copies the whole object store, a dropped stash's secret included.
 */
export function cloneLocal(hostRepoPath: string, clonePath: string): void {
  runOrThrow(["git", "clone", "--no-local", "--quiet", `file://${hostRepoPath}`, clonePath]);
}

export function checkoutNewBranch(clonePath: string, name: string, baseSha: string): void {
  runOrThrow(["git", "-C", clonePath, "checkout", "--quiet", "-b", name, baseSha]);
}

export function checkoutBranch(clonePath: string, name: string): void {
  runOrThrow(["git", "-C", clonePath, "checkout", "--quiet", name]);
}

/** `undefined` when `repoPath` has no such branch, or is not a repo at all. */
export function branchSha(repoPath: string, name: string): string | undefined {
  const result = run(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

/** `git fetch` can exit 0 without having brought back the right object. */
export function assertFetchedBack(ref: string, hostSha: string, cloneSha: string): void {
  if (hostSha !== cloneSha) {
    throw new Error(
      `Fetch-back verification failed for ${ref}: host is at ${hostSha} but the Clone's is ` +
        `${cloneSha}. The Run's work may not have been brought back correctly.`,
    );
  }
}

const FETCH_BACK_ATTEMPTS = 3;

/**
 * The refspec is qualified on both sides: unqualified, git looks up tags before heads and
 * would silently fetch a same-named tag instead of the Run's branch. No leading `+`, so a host
 * branch that moved since the Clone last saw it is refused, never overwritten. No `--quiet`, so git's
 * own reason reaches the error. A `git fetch` killed by a signal was stopped, not refused, and
 * fetching again is safe, so it is retried.
 */
export function fetchBack(
  hostRepoPath: string,
  clonePath: string,
  name: string,
  onKilled?: (signal: string) => void,
): void {
  const ref = `refs/heads/${name}`;
  const args = ["git", "-C", hostRepoPath, "fetch", clonePath, `${ref}:${ref}`];
  for (let attempt = 1; ; attempt++) {
    const result = run(args);
    if (result.exitCode === 0) break;
    if (result.signal !== undefined && attempt < FETCH_BACK_ATTEMPTS) {
      onKilled?.(result.signal);
      continue;
    }
    throw new Error(
      `\`${args.join(" ")}\` failed: ${result.stderr.trim() || result.stdout.trim() || `killed by ${result.signal}`}`,
    );
  }
  const cloneSha = runOrThrow(["git", "-C", clonePath, "rev-parse", ref]);
  const hostSha = runOrThrow(["git", "-C", hostRepoPath, "rev-parse", ref]);
  assertFetchedBack(ref, hostSha, cloneSha);
}

/**
 * Reachable from what `cloneLocal` transfers — a local branch, a tag, or HEAD — not merely
 * present in the object store. Remote-tracking refs and stashes never reach the Clone, and a
 * detached HEAD has no ref under `refs/` to list, hence the separate `merge-base` check.
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

/** `^{commit}` peels an annotated tag, whose own sha is not a commit. */
export function resolveBaseSha(repoPath: string, ref: string): string {
  return shortSha(repoPath, `${ref}^{commit}`);
}

/** Claude Code's default attribution trailers. A Sandbox is given one identity, so no co-author is legitimate. */
const ATTRIBUTION_PATTERN = /co-authored-by|generated (with|by)\b/i;

/** Control bytes, because a commit message (`%B`) can contain any printable separator. */
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

interface ScannedCommit {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  message: string;
}

function parseScannedCommits(output: string): ScannedCommit[] {
  return output
    .split(RECORD_SEP)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", authorName = "", authorEmail = "", committerName = "", committerEmail = "", ...rest] =
        record.split(FIELD_SEP);
      return { sha, authorName, authorEmail, committerName, committerEmail, message: rest.join(FIELD_SEP) };
    });
}

function identityMismatch(name: string, email: string, identity: GitIdentity): boolean {
  return name !== identity.name || email !== identity.email;
}

/** Flags, never rewrites, an attribution trailer or an identity other than the one passed in. */
export function scanCommitsForWarnings(
  clonePath: string,
  range: string,
  identity: GitIdentity,
): string[] {
  const format = `%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%cn${FIELD_SEP}%ce${FIELD_SEP}%B${RECORD_SEP}`;
  const result = run(["git", "-C", clonePath, "log", `--format=${format}`, range]);
  if (result.exitCode !== 0) {
    throw new Error(`\`git log ${range}\` failed: ${result.stderr.trim()}`);
  }

  const warnings: string[] = [];
  for (const commit of parseScannedCommits(result.stdout)) {
    const abbreviatedSha = commit.sha.slice(0, 7);
    if (ATTRIBUTION_PATTERN.test(commit.message)) {
      warnings.push(`commit ${abbreviatedSha} carries an AI attribution trailer`);
    }
    if (identityMismatch(commit.authorName, commit.authorEmail, identity)) {
      warnings.push(
        `commit ${abbreviatedSha} has an unexpected author "${commit.authorName} <${commit.authorEmail}>"`,
      );
    }
    if (identityMismatch(commit.committerName, commit.committerEmail, identity)) {
      warnings.push(
        `commit ${abbreviatedSha} has an unexpected committer "${commit.committerName} <${commit.committerEmail}>"`,
      );
    }
  }
  return warnings;
}

/** `undefined` when the range leaves `file` untouched; otherwise the lines it adds, without the `+`. */
export function addedLines(clonePath: string, range: string, file: string): string[] | undefined {
  const result = run(["git", "-C", clonePath, "diff", "--no-color", "--no-ext-diff", "--unified=0", range, "--", file]);
  if (result.exitCode !== 0) {
    throw new Error(`\`git diff ${range} -- ${file}\` failed: ${result.stderr.trim()}`);
  }
  if (result.stdout.trim() === "") return undefined;
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}
