import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BUILT_IN_ALLOWLIST, isInternalHostname, isPlainHostname } from "./network";
import type { Blocked } from "./network";
import { readTextAtCommit } from "./git";
import { REPO_ALLOWLIST_FILE, repoAllowlistPath, userAllowlistPath } from "./paths";

/**
 * Every host on a user or repo level ends up inside a tinyproxy filter regex and, through the
 * end-of-run advice, in a line the user is told to paste — so anything but a plain public hostname
 * is refused at the door, never escaped later.
 */
function normalizeHost(raw: string, source: string): string {
  const host = raw.trim().toLowerCase();
  if (!isPlainHostname(host)) {
    throw new Error(
      `${source}: ${JSON.stringify(raw)} is not a plain hostname (letters, digits and hyphens, ` +
        "dot-separated, no port, no wildcard, no IP address).",
    );
  }
  if (isInternalHostname(host)) {
    throw new Error(
      `${source}: ${JSON.stringify(raw)} names a host inside your machine, its containers or your ` +
        "network; the Allowlist never opens one.",
    );
  }
  return host;
}

/** By index, not a `#.*$` regex: `.` stops at the `\r` of a CRLF line and the comment survives. */
function withoutComment(line: string): string {
  const hash = line.indexOf("#");
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

export function parseAllowlistFile(text: string, sourcePath: string): string[] {
  return text
    .split("\n")
    .map(withoutComment)
    .filter((line) => line.length > 0)
    .map((line) => normalizeHost(line, sourcePath));
}

function readLevel(file: string): string[] {
  if (!existsSync(file)) return [];
  return parseAllowlistFile(readFileSync(file, "utf8"), file);
}

/** As `baseSha` commits it: a host edit nobody committed never reaches a Run, whose Clone cannot hold it. */
export function readRepoLevelAtCommit(hostRepoPath: string, baseSha: string): string[] {
  const text = readTextAtCommit(hostRepoPath, baseSha, REPO_ALLOWLIST_FILE);
  return text === undefined ? [] : parseAllowlistFile(text, `${REPO_ALLOWLIST_FILE} (as committed at ${baseSha})`);
}

export type AllowlistLevel = "built-in" | "user" | "repo";

export interface AllowlistEntry {
  host: string;
  level: AllowlistLevel;
}

/** Throws on the first host a level cannot carry, so a Run fails before anything starts. */
export function allowlistByLevel(home: string, repoLevel: readonly string[]): AllowlistEntry[] {
  const entries = new Map<string, AllowlistEntry>();
  const add = (hosts: readonly string[], level: AllowlistLevel) => {
    for (const host of hosts) if (!entries.has(host)) entries.set(host, { host, level });
  };
  add(BUILT_IN_ALLOWLIST, "built-in");
  add(readLevel(userAllowlistPath(home)), "user");
  add(repoLevel, "repo");
  return [...entries.values()];
}

/** The host's working tree, for advice about what to paste there; a Run reads `readRepoLevelAtCommit`. */
export function mergedAllowlist(home: string, hostRepoPath: string): string[] {
  return allowlistByLevel(home, readLevel(repoAllowlistPath(hostRepoPath))).map((entry) => entry.host);
}

/**
 * What a learn Run's hosts are compared against. Never the user level: a host only one developer
 * allowed would never be proposed, and the committed repo level would stay short for everyone else.
 */
export function learnBaseline(hostRepoPath: string): string[] {
  return [...new Set([...BUILT_IN_ALLOWLIST, ...readLevel(repoAllowlistPath(hostRepoPath))])];
}

export type AllowOutcome = "added" | "already" | "built-in";

/** Appends one line and never rewrites the others, so a hand-written comment always survives. */
function appendToLevel(file: string, raw: string, source: string): { outcome: AllowOutcome; host: string } {
  const host = normalizeHost(raw, source);
  if (BUILT_IN_ALLOWLIST.includes(host)) return { outcome: "built-in", host };
  if (readLevel(file).includes(host)) return { outcome: "already", host };
  mkdirSync(path.dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const separator = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  appendFileSync(file, `${separator}${host}\n`);
  return { outcome: "added", host };
}

export function addToUserAllowlist(home: string, raw: string): { outcome: AllowOutcome; host: string } {
  return appendToLevel(userAllowlistPath(home), raw, "crisol allow");
}

export function addToRepoAllowlist(hostRepoPath: string, raw: string): { outcome: AllowOutcome; host: string } {
  return appendToLevel(repoAllowlistPath(hostRepoPath), raw, "crisol allow --repo");
}

/**
 * What a learn Run reached is whatever the agent asked for, so only a plain public hostname on its
 * scheme's own port is proposed: the Allowlist never opens a port or a host inside the machine, and
 * anything else would be printed as a line the user is told to paste.
 */
export function hostsToLearn(reached: readonly Blocked[], baseline: readonly string[]): string[] {
  const hosts = reached
    .filter(
      (entry) =>
        entry.port === undefined &&
        isPlainHostname(entry.host) &&
        !isInternalHostname(entry.host) &&
        !baseline.includes(entry.host),
    )
    .map((entry) => entry.host);
  return [...new Set(hosts)];
}

/**
 * The repo level is committed, so a branch can widen it, and the agent writes the branch: once
 * merged, every later Run in the repo reaches what it added. The lines are the agent's own text,
 * hence quoted and unvalidated.
 */
export function repoLevelChangeWarning(addedLines: readonly string[]): string {
  const hosts = addedLines.map(withoutComment).filter((line) => line.length > 0);
  const what = hosts.length > 0 ? `adds ${hosts.map((host) => JSON.stringify(host)).join(", ")} to` : "changes";
  return `the branch ${what} ${REPO_ALLOWLIST_FILE}: once merged, every later Run in this repo reads it`;
}
