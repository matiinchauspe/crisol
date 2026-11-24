import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

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

/** Bytes, not text, so a caller can refuse non-UTF-8 (task.ts does, with a fatal decoder). `undefined` when `sha` has no such file. */
export function readFileAtCommit(repoPath: string, sha: string, file: string): Uint8Array | undefined {
  const proc = Bun.spawnSync(["git", "-C", repoPath, "cat-file", "blob", `${sha}:${file}`], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  return proc.exitCode === 0 ? new Uint8Array(proc.stdout) : undefined;
}

/** Files with uncommitted changes (untracked included) under `dir`, relative to the repo root. */
export function uncommittedFilesUnder(repoPath: string, dir: string): string[] {
  const result = run(["git", "-C", repoPath, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", dir]);
  if (result.exitCode !== 0) return [];
  const entries = result.stdout.split("\0").filter((entry) => entry.length > 0);
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i]!.slice(0, 2);
    files.push(entries[i]!.slice(3));
    // A rename or copy is followed by its origin as an entry of its own.
    if (/[RC]/.test(status)) i++;
  }
  return files;
}

export function readTextAtCommit(repoPath: string, sha: string, file: string): string | undefined {
  const bytes = readFileAtCommit(repoPath, sha, file);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
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

/** Only ever before a Sandbox mounts the Clone, while its `.git` is still the one `cloneLocal` made. */
export function checkoutNewBranch(clonePath: string, name: string, baseSha: string): void {
  runOrThrow(["git", "-C", clonePath, "checkout", "--quiet", "-b", name, baseSha]);
}

/** `undefined` when `repoPath` has no such branch, or is not a repo at all. */
export function branchSha(repoPath: string, name: string): string | undefined {
  const result = run(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

/**
 * A gitfile or a symlink in its place would point host git at whatever gitdir the agent named — the
 * host repo's own among them.
 */
function assertCloneGitDir(clonePath: string): void {
  const gitDir = path.join(clonePath, ".git");
  let isDirectory = false;
  try {
    isDirectory = lstatSync(gitDir).isDirectory();
  } catch {}
  if (!isDirectory) {
    throw new Error(`${gitDir} is no longer a directory, so Crisol runs no git command against this Clone.`);
  }
}

/**
 * The agent writes the Clone's `.git`, so host git reads it only as a remote: `upload-pack` is the
 * one side git restricts to the config and hooks that are safe to serve.
 */
export function cloneBranchSha(clonePath: string, name: string): string | undefined {
  if (!existsSync(clonePath)) return undefined;
  assertCloneGitDir(clonePath);
  const ref = `refs/heads/${name}`;
  const result = run(["git", "ls-remote", clonePath, ref]);
  if (result.exitCode !== 0) return undefined;
  return result.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, refName]) => refName === ref)?.[0];
}

/** Moves no ref, so the host gains only objects; the scans then read the branch from there. */
export function fetchCloneObjects(hostRepoPath: string, clonePath: string, name: string): string {
  const tip = cloneBranchSha(clonePath, name);
  if (tip === undefined) throw new Error(`The Clone at ${clonePath} has no branch "${name}".`);
  runOrThrow(["git", "-C", hostRepoPath, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", clonePath, `refs/heads/${name}`]);
  return tip;
}

/**
 * The worktree path where `branch` is currently checked out — the host repo itself or one of its
 * linked worktrees — or `undefined` when it is checked out nowhere. `git fetch` refuses to update
 * a branch that is any checkout's current branch.
 */
export function checkedOutWorktree(hostRepoPath: string, branch: string): string | undefined {
  const lines = run(["git", "-C", hostRepoPath, "worktree", "list", "--porcelain"]).stdout.split("\n");
  const wantedBranch = `branch refs/heads/${branch}`;
  let worktreePath: string | undefined;
  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      worktreePath = line.slice("worktree ".length).trim();
    } else if (line === wantedBranch) {
      return worktreePath;
    }
  }
  return undefined;
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

function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  return run(["git", "-C", repoPath, "merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0;
}

function branchMovedError(
  hostRepoPath: string,
  name: string,
  roundStart: string | null | undefined,
  hostSha: string | undefined,
  cloneSha: string,
): Error {
  const host = hostSha ?? "no such branch";
  const moved =
    roundStart === undefined
      ? `is at ${host} in ${hostRepoPath}, which the Run's Clone does not hold`
      : `was at ${roundStart ?? "no such branch"} in ${hostRepoPath} when this round began and is at ${host} now`;
  return new Error(
    `Branch "${name}" ${moved}, so Fetch-back left it alone rather than overwrite it. The Run's work is at ` +
      `${cloneSha}; \`git -C ${hostRepoPath} branch ${name}-run ${cloneSha}\` keeps it beside yours.`,
  );
}

/**
 * `git fetch` has no compare-and-swap, so it only brings the objects and `update-ref` moves the
 * branch from a sha the host still holds. `update-ref` also moves a checked-out branch, hence the
 * guard. A fast-forward drops nothing, so it needs no `roundStart`. The ref is qualified: unqualified,
 * git looks up tags before heads and would fetch a same-named tag.
 */
export function fetchBack(
  hostRepoPath: string,
  clonePath: string,
  name: string,
  roundStart: string | null | undefined,
  onKilled?: (signal: string) => void,
): void {
  assertCloneGitDir(clonePath);
  const ref = `refs/heads/${name}`;
  const worktree = checkedOutWorktree(hostRepoPath, name);
  if (worktree !== undefined) {
    throw new Error(
      `Branch "${name}" is checked out at ${worktree}; Fetch-back cannot move a branch git has checked out. ` +
        "Check out something else there, then run `crisol recover`.",
    );
  }
  const cloneSha = cloneBranchSha(clonePath, name);
  if (cloneSha === undefined) throw new Error(`The Clone at ${clonePath} has no branch "${name}".`);
  // A tag the agent made must never land in the host; a fetch killed by a signal is safe to retry.
  const args = ["git", "-C", hostRepoPath, "fetch", "--no-tags", "--no-write-fetch-head", clonePath, ref];
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

  const hostSha = branchSha(hostRepoPath, name);
  if (hostSha !== cloneSha) {
    let expected: string;
    if (roundStart !== undefined && hostSha === (roundStart ?? undefined)) expected = roundStart ?? "";
    else if (hostSha !== undefined && isAncestor(hostRepoPath, hostSha, cloneSha)) expected = hostSha;
    else if (roundStart === undefined && hostSha === undefined) expected = "";
    else throw branchMovedError(hostRepoPath, name, roundStart, hostSha, cloneSha);
    const moved = run(["git", "-C", hostRepoPath, "update-ref", "-m", "crisol: fetch-back", ref, cloneSha, expected]);
    if (moved.exitCode !== 0) {
      const now = branchSha(hostRepoPath, name);
      if (now !== hostSha) throw branchMovedError(hostRepoPath, name, roundStart, now, cloneSha);
      throw new Error(`Fetch-back could not move branch "${name}" in ${hostRepoPath}: ${moved.stderr.trim()}`);
    }
  }
  assertFetchedBack(ref, runOrThrow(["git", "-C", hostRepoPath, "rev-parse", ref]), cloneSha);
}

/** `false`, never a throw, for a sha the repo does not hold at all. */
export function isReachableFromBranchOrTag(repoPath: string, sha: string): boolean {
  return (
    run(["git", "-C", repoPath, "for-each-ref", "--count=1", "--contains", sha, "refs/heads/", "refs/tags/"])
      .stdout.trim().length > 0
  );
}

/**
 * Reachable from what `cloneLocal` transfers — a local branch, a tag, or HEAD — not merely
 * present in the object store. Remote-tracking refs and stashes never reach the Clone, and a
 * detached HEAD has no ref under `refs/` to list, hence the separate `merge-base` check.
 */
export function isReachableFromClonedRefs(repoPath: string, sha: string): boolean {
  if (isReachableFromBranchOrTag(repoPath, sha)) return true;
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
  repoPath: string,
  range: string,
  identity: GitIdentity,
): string[] {
  const format = `%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%cn${FIELD_SEP}%ce${FIELD_SEP}%B${RECORD_SEP}`;
  const result = run(["git", "-C", repoPath, "log", `--format=${format}`, range]);
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
export function addedLines(repoPath: string, range: string, file: string): string[] | undefined {
  const result = run(["git", "-C", repoPath, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=0", range, "--", file]);
  if (result.exitCode !== 0) {
    throw new Error(`\`git diff ${range} -- ${file}\` failed: ${result.stderr.trim()}`);
  }
  if (result.stdout.trim() === "") return undefined;
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}
