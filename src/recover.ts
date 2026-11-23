import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { listRunSandboxIds, removeRunSandboxes } from "./docker";
import { branchSha, cloneBranchSha, fetchBack } from "./git";
import { removeNetworkByRunId } from "./network";
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
  /** One per dead Run whose Allowlist network outlived it. */
  networkWarnings: string[];
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

/**
 * The Run lock is rewritten at every round's own reservation, so one newer than the result it
 * names proves a round began after that result was written and never wrote one.
 */
export function resultIsStale(id: string, home: string, result: RunResult): boolean {
  if (typeof result.finishedAt !== "number") return false;
  try {
    // mtimeMs has a sub-ms fraction finishedAt lacks; floor it or a same-tick write reads as stale.
    return Math.floor(statSync(runLockPath(id, home)).mtimeMs) > result.finishedAt;
  } catch {
    return false;
  }
}

/** The field list deliberately omits the stale `finalMessage`. */
function settleResult(id: string, home: string): void {
  const resultPath = runResultPath(id, home);
  if (!existsSync(resultPath)) return;
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
  if (resultIsStale(id, home, result)) {
    const settled: RunResult = {
      run: result.run,
      branch: result.branch,
      base: result.base,
      status: "not-converged",
      reason: "interrupted: the round ended before it wrote a result",
      ...(result.adapter !== undefined ? { adapter: result.adapter } : {}),
      iterations: result.iterations,
      gates: result.gates,
      network: result.network,
      blocked: result.blocked,
      ...(result.reached !== undefined ? { reached: result.reached } : {}),
      warnings: result.warnings,
      fetchBack: true,
      finishedAt: Date.now(),
    };
    writeFileSync(resultPath, JSON.stringify(settled, null, 2));
    return;
  }
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
    // The proxy container carries the same label, so this sweep removes it too.
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
  let cloneSha: string | undefined;
  try {
    cloneSha = cloneBranchSha(clonePath, record.branch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(id, home, `recover refused the Clone: ${message}`);
    return { run: id, kind: "failed", error: message };
  }
  if (cloneSha === undefined) return { run: id, kind: "skipped", why: `${record.branch} was never cut in its Clone` };
  if (!existsSync(record.host)) return { run: id, kind: "failed", error: `its host repo ${record.host} is gone` };

  if (branchSha(record.host, record.branch) === cloneSha) {
    settleResult(id, home);
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
  settleResult(id, home);
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
  const report: RecoverReport = { outcomes: [], networkWarnings: [] };
  if (sandboxIds === undefined) {
    report.dockerWarning =
      "Docker could not be asked for leftover Sandboxes; a dead Run's agent may still be writing to its Clone, " +
      "and its Allowlist network is left in place.";
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
      // After fetch-back, and only when Docker answered: a network left behind is a leak to report,
      // never a reason to leave the branch unrecovered.
      if (sandboxIds !== undefined) {
        const networkRemoved = await removeNetworkByRunId(id);
        if (!networkRemoved.ok) {
          appendLog(id, home, `Allowlist network removal failed: ${networkRemoved.stderr}`);
          report.networkWarnings.push(
            `Run ${id}: its Allowlist network crisol-net-${id} could not be removed (${networkRemoved.stderr}).`,
          );
        }
      }
    } finally {
      lock.release();
    }
  }
  return report;
}
