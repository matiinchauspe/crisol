import type { Sandbox } from "./docker";

export interface Gate {
  cmd: string;
  ok: boolean;
}

/** What `converge`'s resume message is built from. */
export interface GateFailure {
  cmd: string;
  output: string;
}

export interface GateRunResult {
  /** Never truncated at the first failure. */
  results: Gate[];
  /** The first red Gate, if any; `converge` resumes with only this one. */
  firstFailure?: GateFailure;
}

/** Deliberately never stops at the first red Gate — later Gates still matter for the Run result, even once one has failed. */
export async function runGates(
  sandbox: Sandbox,
  gates: readonly string[],
): Promise<GateRunResult> {
  const results: Gate[] = [];
  let firstFailure: GateFailure | undefined;
  for (const cmd of gates) {
    const execResult = await sandbox.exec(["bash", "-c", cmd]);
    const ok = execResult.exitCode === 0;
    results.push({ cmd, ok });
    if (!ok && firstFailure === undefined) {
      firstFailure = { cmd, output: `${execResult.stdout}${execResult.stderr}`.trim() };
    }
  }
  return { results, firstFailure };
}

/** `fingerprint` is the blob install left there, or `-` for a directory or a deleted file. */
export interface InstallDirt {
  path: string;
  fingerprint: string;
}

interface StatusEntry {
  path: string;
  line: string;
}

/** `-z` keeps paths unquoted and gives a rename's source its own field, so neither needs unescaping. */
function parseStatus(output: string): StatusEntry[] {
  const fields = output.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field === "") continue;
    const xy = field.slice(0, 2);
    const entryPath = field.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      entries.push({ path: entryPath, line: `${xy} ${fields[++i]} -> ${entryPath}` });
    } else {
      entries.push({ path: entryPath, line: field });
    }
  }
  return entries;
}

async function readStatus(sandbox: Sandbox): Promise<{ entries: StatusEntry[] } | { error: string }> {
  const status = await sandbox.exec(["git", "status", "--porcelain", "-z"]);
  if (status.exitCode !== 0) return { error: `${status.stdout}${status.stderr}`.trim() };
  return { entries: parseStatus(status.stdout) };
}

async function fingerprint(sandbox: Sandbox, entryPath: string): Promise<string> {
  if (entryPath.endsWith("/")) return "-";
  const hashed = await sandbox.exec(["git", "hash-object", "--", entryPath]);
  return hashed.exitCode === 0 ? hashed.stdout.trim() : "-";
}

/** Every install but `npm ci` may rewrite the lockfile, and an unignored `node_modules` shows untracked: dirt the agent never made. */
export async function snapshotInstallDirt(sandbox: Sandbox): Promise<InstallDirt[]> {
  const status = await readStatus(sandbox);
  if ("error" in status) {
    throw new Error(`\`git status\` in the Clone failed after the dependency install: ${status.error}`);
  }
  const dirt: InstallDirt[] = [];
  for (const entry of status.entries) {
    dirt.push({ path: entry.path, fingerprint: await fingerprint(sandbox, entry.path) });
  }
  return dirt;
}

/**
 * Fetch-back takes only `refs/heads/<branch>`, so a Gate run on anything else would vouch for work
 * that never leaves the Clone. Runs in the Sandbox, since the Clone's `.git` is agent-written.
 */
export async function checkCommitted(
  sandbox: Sandbox,
  branch: string,
  installDirt: readonly InstallDirt[] = [],
): Promise<string | undefined> {
  const expected = `refs/heads/${branch}`;
  const head = await sandbox.exec(["git", "symbolic-ref", "--quiet", "HEAD"]);
  const status = await readStatus(sandbox);

  const problems: string[] = [];
  const headRef = head.stdout.trim();
  if (head.exitCode !== 0) {
    problems.push(`HEAD is detached, not ${expected}.`);
  } else if (headRef !== expected) {
    problems.push(`HEAD is ${headRef}, not ${expected}.`);
  }
  if ("error" in status) {
    problems.push(`\`git status --porcelain\` failed:\n${status.error}`);
  } else {
    const leftByInstall = new Map(installDirt.map((dirt) => [dirt.path, dirt.fingerprint]));
    const uncommitted: string[] = [];
    for (const entry of status.entries) {
      const installed = leftByInstall.get(entry.path);
      // Compared by content, so an agent that edits the rewritten lockfile further still commits it.
      if (installed !== undefined && (await fingerprint(sandbox, entry.path)) === installed) continue;
      uncommitted.push(entry.line);
    }
    if (uncommitted.length > 0) {
      problems.push(`Uncommitted changes (\`git status --porcelain\`):\n${uncommitted.join("\n")}`);
    }
  }
  if (problems.length === 0) return undefined;

  return [
    `Gates did not run: only the commits on branch \`${branch}\` leave the Sandbox, and the Clone is not there yet.`,
    ...problems,
    `Commit your work on \`${branch}\`, with HEAD on it, then finish your turn.`,
  ].join("\n\n");
}

/** Exported so a test can assert on the exact shape without re-deriving it. */
export function formatGateFeedback(failure: GateFailure): string {
  return `Gate failed: ${failure.cmd}\n\n${failure.output}`;
}

/**
 * Gate ladder: `--gate` beats the repo's `.crisol/config.toml` gates beats none.
 * CLI gates REPLACE the repo's, never merge with them. An empty `--gate` list
 * falls through to the repo rung exactly like `undefined` does.
 */
export function resolveGates(
  cliGates: readonly string[] | undefined,
  repoGates: readonly string[],
): readonly string[] {
  if (cliGates !== undefined && cliGates.length > 0) return cliGates;
  return repoGates;
}
