import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { branchExists } from "./git";
import { runDir, runLockPath, runLogPath, runPidPath, runRepoPath, runResultPath, runsRoot } from "./paths";
import { readRunLockRecord, resultIsStale } from "./recover";
import type { RunResult } from "./run";
import { probeRunLock } from "./slots";
import type { SlotLock } from "./slots";

export type RunEntry =
  | { run: string; state: "queued" | "running"; branch: string; pid: number | undefined }
  | { run: string; state: "dead"; branch: string }
  | { run: string; state: "finished"; result: RunResult };

function listRunIds(home: string): string[] {
  return existsSync(runsRoot(home)) ? readdirSync(runsRoot(home)) : [];
}

/** A half-written file reads as `undefined`; its Run still holds its lock then, so it shows as live. */
export function readResult(id: string, home: string): RunResult | undefined {
  try {
    return JSON.parse(readFileSync(runResultPath(id, home), "utf8")) as RunResult;
  } catch {
    return undefined;
  }
}

export interface BranchClaim {
  run: string;
  /** Whether this Run's own Clone still has a local branch by this name — only this one can be resumed from. */
  hasClone: boolean;
  /** Whether Fetch-back ever completed — the one state `crisol gc` requires before it will ever remove a Clone. */
  fetchBack: boolean;
}

/**
 * Every finished Run of `hostRepoPath` whose Run result names `branch`, each flagged with whether
 * its own Clone still holds it. Another repo's same-named branch is not a claim at all.
 */
export function runsNamingBranch(home: string, hostRepoPath: string, branch: string): BranchClaim[] {
  return listRunIds(home)
    .sort()
    .filter((id) => readResult(id, home)?.branch === branch && readRunLockRecord(id, home)?.host === hostRepoPath)
    .map((id) => ({
      run: id,
      hasClone: branchExists(runRepoPath(id, home), branch),
      fetchBack: readResult(id, home)!.fetchBack,
    }));
}

/** The finished Runs of `hostRepoPath` whose own Clone still holds `branch` — the ones a Continuation can resume from. */
export function runsOwningBranch(home: string, hostRepoPath: string, branch: string): string[] {
  return runsNamingBranch(home, hostRepoPath, branch)
    .filter((claim) => claim.hasClone)
    .map((claim) => claim.run);
}

/** `--detach` removes a reservation it could not start, possibly while this reads it. */
function bornAt(id: string, home: string): number | undefined {
  try {
    return statSync(runDir(id, home)).birthtimeMs;
  } catch {
    return undefined;
  }
}

/** Absent for the moment between a detached Run's reservation and its own process taking over. */
function readPid(id: string, home: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(runPidPath(id, home), "utf8"), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

/**
 * Whether `pid` has the Run's lock file open. A held lock proves only that some process holds it:
 * `crisol recover` holds a dead Run's lock for its whole Fetch-back, and the OS may have handed the
 * dead owner's pid to an unrelated process. `undefined` when `lsof` cannot be run at all.
 */
function holdsLockFile(pid: number, lockPath: string): boolean | undefined {
  try {
    const proc = Bun.spawnSync(["lsof", "-a", "-n", "-P", "-w", "-p", String(pid), "--", lockPath], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return proc.exitCode === 0;
  } catch {
    return undefined;
  }
}

function readEntry(id: string, home: string, lock: SlotLock | undefined): RunEntry | undefined {
  const result = readResult(id, home);
  if (result !== undefined && !resultIsStale(id, home, result)) {
    return { run: id, state: "finished", result };
  }
  // Without a record the Run may still be reserving, and taking its lock now would make that fail.
  const record = readRunLockRecord(id, home);
  if (record === undefined) return undefined;
  const lockPath = runLockPath(id, home);
  const probe = probeRunLock(lockPath, lock);
  if (probe === "gone") return undefined;
  if (probe) {
    try {
      // This result may have landed between the first read and now — the second read is not redundant.
      const finalResult = readResult(id, home);
      if (finalResult !== undefined && !resultIsStale(id, home, finalResult)) {
        return { run: id, state: "finished", result: finalResult };
      }
      return { run: id, state: "dead", branch: record.branch };
    } finally {
      probe.release();
    }
  }
  // Without a pid the lock is still with the process that reserved the Run, handing it over.
  const pid = readPid(id, home);
  let shownPid: number | undefined;
  if (pid !== undefined) {
    const owns = holdsLockFile(pid, lockPath);
    if (owns === false) {
      const finalResult = readResult(id, home);
      if (finalResult !== undefined && !resultIsStale(id, home, finalResult)) {
        return { run: id, state: "finished", result: finalResult };
      }
      return { run: id, state: "dead", branch: record.branch };
    }
    if (owns === true) shownPid = pid;
  }
  // A Run makes its Clone first thing after it takes a Slot.
  const state = existsSync(runRepoPath(id, home)) ? "running" : "queued";
  return { run: id, state, branch: record.branch, pid: shownPid };
}

/** Every Run under `home`, oldest first. `lock` is a test seam for the probe's primitive. */
export function listRuns(home: string, lock?: SlotLock): RunEntry[] {
  return listRunIds(home)
    .map((id) => ({ id, born: bornAt(id, home) }))
    .filter((run): run is { id: string; born: number } => run.born !== undefined)
    .sort((a, b) => a.born - b.born)
    .map(({ id }) => readEntry(id, home, lock))
    .filter((entry): entry is RunEntry => entry !== undefined);
}

/** `undefined` for an id that is not a Run under `home`, including one that tries to leave `runs/`. */
export function readRunLog(id: string, home: string): string | undefined {
  if (!listRunIds(home).includes(id)) return undefined;
  const logPath = runLogPath(id, home);
  return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}
