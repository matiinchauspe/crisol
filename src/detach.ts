import { closeSync, openSync, readFileSync } from "node:fs";
import { reserveDetachedRun } from "./run";
import type { DetachedHandoff, RunOptions } from "./run";

const DETACHED_ENV = "CRISOL_DETACHED";

/** fd 0-2 are stdio, so the inherited Run lock is the first extra fd. */
const INHERITED_LOCK_FD = 3;

const TAKEOVER_POLL_MS = 20;

interface DetachedEnv {
  run: string;
  base: string;
  baseSha: string;
}

/** A compiled binary is its own entry point; a script needs Bun and its entry file. */
function selfCommand(): string[] {
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
}

/** `undefined` until the file holds a whole pid; the child may be mid-write. */
function readPid(pidPath: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

/**
 * The child writes its pid only after its signal handlers are armed and it holds the Run, so
 * once the pid is there, a `kill` of it ends the Run with a Run result. Resolves with the exit
 * code instead if the child dies first.
 */
async function waitForTakeover(child: Bun.Subprocess, pidPath: string): Promise<{ exited: number | null }> {
  let exited: number | null | undefined;
  void child.exited.then((code) => {
    exited = code;
  });
  while (readPid(pidPath) !== child.pid) {
    if (exited !== undefined) return { exited };
    await Bun.sleep(TAKEOVER_POLL_MS);
  }
  return { exited: null };
}

/**
 * Reserves the Run here, then starts `crisol run <args>` again in its own session to run it,
 * handing over the Run lock as fd 3 so it is never free in between. Returns once that process
 * has taken the Run over.
 */
export async function detachRun(
  options: RunOptions,
  forwardedArgs: readonly string[],
): Promise<{ id: string; pid: number }> {
  const detached = await reserveDetachedRun(options);
  let child: Bun.Subprocess;
  try {
    const log = openSync(detached.logPath, "a");
    try {
      const env: DetachedEnv = { run: detached.id, base: detached.baseRef, baseSha: detached.baseSha };
      child = Bun.spawn([...selfCommand(), ...forwardedArgs], {
        cwd: options.cwd,
        env: { ...process.env, [DETACHED_ENV]: JSON.stringify(env) },
        stdio: ["ignore", log, log, detached.lock.fd],
        detached: true,
      });
      child.unref();
    } finally {
      closeSync(log);
    }
  } catch (error) {
    detached.discard();
    throw error;
  }

  const takeover = await waitForTakeover(child, detached.pidPath);
  if (takeover.exited !== null) {
    const error = new Error(
      `Run ${detached.id}'s background process exited (code ${takeover.exited}) before it took the Run over; ` +
        `\`crisol logs ${detached.id}\` shows why.`,
    );
    detached.end(error);
    throw error;
  }
  detached.lock.release();
  return { id: detached.id, pid: child.pid };
}

/**
 * In the process `detachRun` started: what it must run, or `undefined` in any other `crisol run`.
 * Cleared once read, so a `crisol run` in a git hook during Fetch-back never takes itself for this
 * Run's process. Spawns that pass no `env` (`docker build`, `claude --version`) still see it, since
 * Bun hands those the environment from process start, and neither runs Crisol.
 */
export function takeDetachedHandoff(): (DetachedHandoff & { base: string; baseSha: string }) | undefined {
  const raw = process.env[DETACHED_ENV];
  if (raw === undefined) return undefined;
  delete process.env[DETACHED_ENV];
  const env = JSON.parse(raw) as DetachedEnv;
  return { run: env.run, lockFd: INHERITED_LOCK_FD, base: env.base, baseSha: env.baseSha };
}
