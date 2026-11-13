import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { listRunSandboxIds, removeRunSandboxes } from "./docker";
import { branchSha, fetchBack } from "./git";
import { runLockPath, runLogPath, runRepoPath, runResultPath, runsRoot } from "./paths";
import type { RunLockRecord, RunResult } from "./run";
import { probeRunLock } from "./slots";

export type RecoverOutcome =
  | { run: string; kind: "live" }
  | { run: string; kind: "up-to-date" }
  | { run: string; kind: "never-cut" }
  | { run: string; kind: "recovered"; branch: string; host: string; sha: string }
  | { run: string; kind: "skipped"; why: string }
  | { run: string; kind: "failed"; error: string };

export interface RecoverReport {
  outcomes: RecoverOutcome[];
  /** Set when Docker could not be asked for a dead Run's Sandbox. */
  dockerWarning?: string;
}

function appendLog(id: string, home: string, line: string): void {
  appendFileSync(runLogPath(id, home), `[${new Date().toISOString()}] recover: ${line}\n`);
}

/** `undefined` while the Run is still being reserved: its record is written only once its lock is held. */
export function readRunLockRecord(id: string, home: string): RunLockRecord | undefined {
  const lockPath = runLockPath(id, home);
  if (!existsSync(lockPath)) return undefined;
  try {
    const record = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<RunLockRecord>;
    return typeof record.host === "string" && typeof record.branch === "string"
      ? { host: record.host, branch: record.branch }
      : undefined;
  } catch {
    return undefined;
  }
}

function markFetchedBack(id: string, home: string): void {
  const resultPath = runResultPath(id, home);
  if (!existsSync(resultPath)) return;
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
  if (result.fetchBack) return;
  writeFileSync(resultPath, JSON.stringify({ ...result, fetchBack: true }, null, 2));
}

/**
 * The dead Run's Sandbox goes first: its agent may still be committing to the Clone, and the
 * branch recover brings back must be the Clone's final commit.
 */
async function recoverDeadRun(
  id: string,
  home: string,
  record: RunLockRecord,
  hasSandbox: boolean,
): Promise<RecoverOutcome> {
  if (hasSandbox) {
    const removed = await removeRunSandboxes(id);
    if (!removed.ok) {
      return { run: id, kind: "failed", error: `its Sandbox crisol-${id} could not be removed: ${removed.stderr}` };
    }
    appendLog(id, home, `removed the dead Run's Sandbox (label crisol.run=${id})`);
  }

  const clonePath = runRepoPath(id, home);
  if (!existsSync(clonePath)) {
    // A Run result means the Run ended on its own terms before cutting a branch; only a Run that
    // died there is worth naming.
    return existsSync(runResultPath(id, home))
      ? { run: id, kind: "never-cut" }
      : { run: id, kind: "skipped", why: "it has no Clone" };
  }
  const cloneSha = branchSha(clonePath, record.branch);
  if (cloneSha === undefined) return { run: id, kind: "skipped", why: `${record.branch} was never cut in its Clone` };
  if (!existsSync(record.host)) return { run: id, kind: "failed", error: `its host repo ${record.host} is gone` };

  if (branchSha(record.host, record.branch) === cloneSha) {
    markFetchedBack(id, home);
    return { run: id, kind: "up-to-date" };
  }
  try {
    fetchBack(record.host, clonePath, record.branch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(id, home, `fetch-back failed: ${message}`);
    return { run: id, kind: "failed", error: message };
  }
  appendLog(id, home, `fetch-back complete: ${record.branch} now in ${record.host} at ${cloneSha}`);
  markFetchedBack(id, home);
  return { run: id, kind: "recovered", branch: record.branch, host: record.host, sha: cloneSha };
}

/**
 * Performs the Fetch-back every dead Run is missing. A Run is dead when its Run lock can be
 * taken; it is held while recover works, so a second recover never races the first. Fetch-back
 * only fast-forwards, so a host branch that has moved on is reported, never overwritten.
 */
export async function recover(home: string): Promise<RecoverReport> {
  const ids = existsSync(runsRoot(home)) ? readdirSync(runsRoot(home)).sort() : [];
  const sandboxIds = ids.length > 0 ? listRunSandboxIds() : new Set<string>();
  const report: RecoverReport = { outcomes: [] };
  if (sandboxIds === undefined) {
    report.dockerWarning =
      "Docker could not be asked for leftover Sandboxes; a dead Run's agent may still be writing to its Clone.";
  }

  for (const id of ids) {
    const record = readRunLockRecord(id, home);
    if (record === undefined) {
      report.outcomes.push({ run: id, kind: "skipped", why: "it has no Run lock record" });
      continue;
    }
    const lock = probeRunLock(runLockPath(id, home));
    if (lock === "gone") continue;
    if (!lock) {
      report.outcomes.push({ run: id, kind: "live" });
      continue;
    }
    try {
      report.outcomes.push(await recoverDeadRun(id, home, record, sandboxIds?.has(id) ?? false));
    } finally {
      lock.release();
    }
  }
  return report;
}
