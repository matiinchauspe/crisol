import { homedir } from "node:os";
import path from "node:path";

/**
 * The only place CRISOL_HOME is read, so every caller agrees where Run state lives. An empty one
 * counts as unset, and a relative one is resolved, so state never scatters under the cwd.
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

/** A running total, sibling to `runs/` so nothing mistakes it for a run id. */
export function runsSizeTrackerPath(home: string = crisolHome()): string {
  return path.join(home, "runs-size");
}

/** Bind-mounted into the Sandbox at this same absolute path. */
export function runRepoPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "repo");
}

export function slotsDir(home: string = crisolHome()): string {
  return path.join(home, "slots");
}

export function userAllowlistPath(home: string = crisolHome()): string {
  return path.join(home, "network");
}

/** Relative to the repo root, where git names it in a diff. */
export const REPO_ALLOWLIST_FILE = ".crisol/network";

export function repoAllowlistPath(hostRepoPath: string): string {
  return path.join(hostRepoPath, REPO_ALLOWLIST_FILE);
}

export function userPromptPath(name: string, home: string = crisolHome()): string {
  return path.join(home, "prompts", `${name}.md`);
}

export function repoPromptPath(hostRepoPath: string, name: string): string {
  return path.join(hostRepoPath, ".crisol", "prompts", `${name}.md`);
}

export function runNetworkDir(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "network");
}

export function runProxyConfPath(id: string, home: string = crisolHome()): string {
  return path.join(runNetworkDir(id, home), "tinyproxy.conf");
}

export function runProxyFilterPath(id: string, home: string = crisolHome()): string {
  return path.join(runNetworkDir(id, home), "filter");
}

export function slotPath(index: number, home: string = crisolHome()): string {
  return path.join(slotsDir(home), `${index}.lock`);
}

export function runLogPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "log");
}

/** Held by a live Run for its whole life; `crisol recover` reads a Run it can lock as dead. */
export function runLockPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "lock");
}

/** The pid of the process that owns the Run, so a detached Run can be stopped with `kill`. */
export function runPidPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "pid");
}

/** What the agent received, written before the Run starts; a detached Run's process reads it from here. */
export function runPromptPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "prompt");
}

export function runResultPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "result.json");
}

/** Mounted over the Adapter's `sessionStore`, so the agent's session outlives its Sandbox. */
export function runSessionStorePath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "sessions");
}

export function runSessionIdPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "session-id");
}

export function runInstallDirtPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "install-dirt.json");
}

/** So a Continuation given no `--gate` verifies against the Gates its Run had. */
export function runGatesPath(id: string, home: string = crisolHome()): string {
  return path.join(runDir(id, home), "gates.json");
}
