import { existsSync, readdirSync, readFileSync } from "node:fs";
import { runLogPath, runRepoPath, runResultPath, runsRoot } from "../../src/paths";
import type { RunResult } from "../../src/run";

export function runIds(home: string): string[] {
  return existsSync(runsRoot(home)) ? readdirSync(runsRoot(home)) : [];
}

export function onlyRunId(home: string): string {
  const ids = runIds(home);
  if (ids.length !== 1) throw new Error(`expected exactly one Run under ${home}, found ${ids.length}`);
  return ids[0]!;
}

export function readLog(id: string, home: string): string {
  return existsSync(runLogPath(id, home)) ? readFileSync(runLogPath(id, home), "utf8") : "";
}

export function readResult(id: string, home: string): RunResult | undefined {
  const file = runResultPath(id, home);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RunResult) : undefined;
}

/** `undefined` when the ref does not exist. */
export function refSha(repoPath: string, branch: string): string | undefined {
  const proc = Bun.spawnSync(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0 ? proc.stdout.toString("utf8").trim() : undefined;
}

export function cloneSha(id: string, home: string, branch: string): string | undefined {
  return refSha(runRepoPath(id, home), branch);
}

export function commitSubjects(repoPath: string, ref: string): string[] {
  const proc = Bun.spawnSync(["git", "-C", repoPath, "log", "--format=%s", ref], { stdout: "pipe" });
  return proc.stdout.toString("utf8").trim().split("\n").filter(Boolean);
}

/** Every container carrying the Run's label, running or not. */
export function runContainers(id: string): string[] {
  const proc = Bun.spawnSync(["docker", "ps", "-aq", "--filter", `label=crisol.run=${id}`], { stdout: "pipe" });
  return proc.stdout.toString("utf8").trim().split("\n").filter(Boolean);
}

/** For tests whose Run Crisol could not tear down itself (SIGKILL, a forced stop failure). */
export function removeRunContainers(id: string): void {
  for (const container of runContainers(id)) {
    Bun.spawnSync(["docker", "rm", "-f", container], { stdout: "ignore", stderr: "ignore" });
  }
}
