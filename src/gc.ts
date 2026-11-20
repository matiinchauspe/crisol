import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GlobalConfig } from "./config";
import { branchSha } from "./git";
import { runLockPath, runNetworkDir, runRepoPath, runSessionStorePath, runsRoot, runsSizeTrackerPath } from "./paths";
import { readRunLockRecord } from "./recover";
import { readResult } from "./runs";
import { probeRunLock } from "./slots";

export const GC_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** About five Runs at 4 GB each. */
export const GC_SIZE_WARNING_BYTES = 20_000_000_000;

export function resolveGcWarnBytes(globalConfig: GlobalConfig): number {
  return globalConfig.gcWarnBytes ?? GC_SIZE_WARNING_BYTES;
}

export interface GcCandidate {
  run: string;
  branch: string;
  host: string;
  /** What `collectRun` removes. */
  sizeBytes: number;
  /** Releases the Run lock `planGc` took to prove the Run safe to collect. Idempotent. */
  release(): void;
}

export type GcSkipKind =
  | "not-fetched-back"
  | "not-converged"
  | "too-young"
  | "no-record"
  | "host-missing"
  | "branch-moved"
  | "in-use";

export interface GcSkip {
  run: string;
  kind: GcSkipKind;
  why: string;
}

export interface GcPlan {
  collectable: GcCandidate[];
  skipped: GcSkip[];
}

function dirSizeBytes(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    total += entry.isDirectory() && !entry.isSymbolicLink() ? dirSizeBytes(entryPath) : lstatSync(entryPath).size;
  }
  return total;
}

/** One Run only — never the whole of `runs/`. */
export function runDirSizeBytes(id: string, home: string): number {
  return (
    dirSizeBytes(runRepoPath(id, home)) +
    dirSizeBytes(runNetworkDir(id, home)) +
    dirSizeBytes(runSessionStorePath(id, home))
  );
}

function readTrackedSize(home: string): number {
  try {
    const value = Number.parseInt(readFileSync(runsSizeTrackerPath(home), "utf8").trim(), 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** A running total, read once — never a walk of `runs/`. Absent reads as 0: a Run finishing or `gc` collecting is what seeds it. */
export function trackedRunsSizeBytes(home: string): number {
  return readTrackedSize(home);
}

/** Never blocks a Run on this: a lost update under real concurrency just leaves the next warning a little off. */
export function addTrackedSize(home: string, deltaBytes: number): void {
  writeFileSync(runsSizeTrackerPath(home), String(Math.max(0, readTrackedSize(home) + deltaBytes)));
}

/** The true total over every Run dir under `runs/` — explicit and rare, so a full walk here is fine. */
export function measureRunsSizeBytes(home: string): number {
  return existsSync(runsRoot(home))
    ? readdirSync(runsRoot(home)).reduce((sum, id) => sum + runDirSizeBytes(id, home), 0)
    : 0;
}

/** The only place drift — a hand-removed dir, a recovered Run that never added, anything from before this tracker existed — gets corrected. */
export function reconcileTrackedSize(home: string): number {
  const total = measureRunsSizeBytes(home);
  writeFileSync(runsSizeTrackerPath(home), String(total));
  return total;
}

export function formatGb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function formatSizeWarning(totalBytes: number, thresholdBytes: number = GC_SIZE_WARNING_BYTES): string | undefined {
  if (totalBytes <= thresholdBytes) return undefined;
  return `Run dirs under ~/.crisol/runs total ${formatGb(totalBytes)}; \`crisol gc\` frees the old ones.`;
}

/** Only a Run with a written result is gc's to consider; a live or dead one is `crisol recover`'s. */
function finishedRunIds(home: string): string[] {
  return existsSync(runsRoot(home)) ? readdirSync(runsRoot(home)).filter((id) => readResult(id, home) !== undefined) : [];
}

/**
 * The branch's tip in its own Clone, which still holds it: `fetchBack: true` means the host
 * SHOULD already be there too, so a mismatch means the host moved since Fetch-back, never that
 * the Clone is wrong — gc only ever reads one, it never writes one.
 */
function hostBranchOutcome(
  host: string,
  clonePath: string,
  branch: string,
): { ok: true } | { ok: false; kind: "host-missing" | "branch-moved"; why: string } {
  if (!existsSync(host)) return { ok: false, kind: "host-missing", why: `its host repo ${host} is gone` };
  const cloneSha = branchSha(clonePath, branch);
  if (cloneSha === undefined) {
    return { ok: false, kind: "branch-moved", why: `"${branch}" is missing from its own Clone` };
  }
  const hostSha = branchSha(host, branch);
  if (hostSha === undefined) {
    return { ok: false, kind: "branch-moved", why: `"${branch}" no longer exists in ${host}` };
  }
  if (hostSha !== cloneSha) {
    return {
      ok: false,
      kind: "branch-moved",
      why: `"${branch}" in ${host} is at ${hostSha.slice(0, 7)}, not the Run's ${cloneSha.slice(0, 7)}`,
    };
  }
  return { ok: true };
}

export function planGc(home: string, options: { includeFailed: boolean }): GcPlan {
  const collectable: GcCandidate[] = [];
  const skipped: GcSkip[] = [];
  const now = Date.now();

  for (const id of finishedRunIds(home).sort()) {
    const result = readResult(id, home)!;
    if (!result.fetchBack) {
      skipped.push({ run: id, kind: "not-fetched-back", why: "its Fetch-back never completed; run `crisol recover` first" });
      continue;
    }
    if (result.status === "not-converged" && !options.includeFailed) {
      skipped.push({ run: id, kind: "not-converged", why: "not-converged; pass --include-failed to collect it anyway" });
      continue;
    }
    if (typeof result.finishedAt !== "number" || !Number.isFinite(result.finishedAt)) {
      // A missing finishedAt makes age unknown, never "old enough".
      skipped.push({ run: id, kind: "no-record", why: "its Run result has no finishedAt; remove it by hand" });
      continue;
    }
    if (now - result.finishedAt < GC_MIN_AGE_MS) {
      const ageDays = Math.floor((now - result.finishedAt) / (24 * 60 * 60 * 1000));
      skipped.push({ run: id, kind: "too-young", why: `only ${ageDays} day(s) old; gc collects after 7` });
      continue;
    }

    const record = readRunLockRecord(id, home);
    if (record === undefined) {
      skipped.push({ run: id, kind: "no-record", why: "its Run lock record is missing" });
      continue;
    }

    const clonePath = runRepoPath(id, home);
    if (!existsSync(clonePath)) continue; // already collected, or re-planned against the same result

    // Held until collected or declined, so a Continuation cannot start on a Clone about to be deleted.
    const lock = probeRunLock(runLockPath(id, home));
    if (lock === "gone") continue; // raced with another process clearing the Run; nothing to plan
    if (!lock) {
      skipped.push({ run: id, kind: "in-use", why: "its Run lock is held; a Continuation is queued or running" });
      continue;
    }

    const outcome = hostBranchOutcome(record.host, clonePath, record.branch);
    if (!outcome.ok) {
      lock.release();
      skipped.push({ run: id, kind: outcome.kind, why: outcome.why });
      continue;
    }

    const sizeBytes = runDirSizeBytes(id, home);
    collectable.push({ run: id, branch: record.branch, host: record.host, sizeBytes, release: () => lock.release() });
  }

  return { collectable, skipped };
}

/**
 * Keeps the Run's record — `log`, `result.json` and the small files beside them. A collected Run
 * cannot be continued: its Clone and its agent's session go with `repo/` and `sessions/`.
 */
export function collectRun(id: string, home: string): void {
  rmSync(runRepoPath(id, home), { recursive: true, force: true });
  rmSync(runNetworkDir(id, home), { recursive: true, force: true });
  rmSync(runSessionStorePath(id, home), { recursive: true, force: true });
}
