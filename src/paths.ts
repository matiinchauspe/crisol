import { homedir } from "node:os";
import path from "node:path";

/**
 * The only place CRISOL_HOME is read, so every caller agrees on where Run state lives.
 * An empty string is treated as unset, not as "resolve relative to cwd"; a configured
 * value is `path.resolve`d so a relative value can't scatter state under the cwd.
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

/** Created once, not per-id — must exist before a run id is reserved. */
export function runsRoot(home: string = crisolHome()): string {
  return path.join(home, "runs");
}

/** Bind-mounted into the Sandbox at this same absolute path. */
export function runRepoPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "repo");
}

export function runLogPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "log");
}

export function runResultPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "result.json");
}
