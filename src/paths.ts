import { homedir } from "node:os";
import path from "node:path";

/**
 * Every path Crisol reads or writes resolves from here — the ONE place
 * CRISOL_HOME is read, so every caller agrees on where Run state lives
 * (spec, "State and cleanup" q13: `~/.crisol/runs/<id>/{repo/, log,
 * result.json}`).
 *
 * An empty-string `CRISOL_HOME` (the test CLI helper's own default when no
 * home is given) is treated the same as unset, never as "resolve everything
 * relative to cwd" — and whatever IS configured is `path.resolve`d, so a
 * relative value never silently scatters Run state under whatever directory
 * happened to be the current one.
 */
export function crisolHome(): string {
  const configured = process.env.CRISOL_HOME;
  if (configured === undefined || configured === "") {
    return path.join(homedir(), ".crisol");
  }
  return path.resolve(configured);
}

export function runDir(id: string, home: string = crisolHome()): string {
  return path.join(home, "runs", id);
}

/** The parent of every Run dir — created once (not per-id) before a run id is reserved (spec, "State and cleanup" q13; ticket 01 fix W2). */
export function runsRoot(home: string = crisolHome()): string {
  return path.join(home, "runs");
}

/** The Clone's own location — bind-mounted into the Sandbox at this SAME absolute path (spec q6). */
export function runRepoPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "repo");
}

export function runLogPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "log");
}

export function runResultPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "result.json");
}
