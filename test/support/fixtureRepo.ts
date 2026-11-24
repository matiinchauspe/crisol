import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FixtureRepo {
  path: string;
  cleanup(): void;
}

function sh(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`\`${args.join(" ")}\` failed in ${cwd}: ${proc.stderr.toString("utf8")}`);
  }
}

/** A throwaway host git repo: its own identity, one commit on `main`, nothing else. */
export function createFixtureRepo(): FixtureRepo {
  const repoPath = mkdtempSync(path.join(tmpdir(), "crisol-fixture-repo-"));
  sh(["git", "init", "--quiet", "--initial-branch=main"], repoPath);
  sh(["git", "config", "user.name", "Crisol Fixture"], repoPath);
  sh(["git", "config", "user.email", "fixture@crisol.test"], repoPath);
  writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  sh(["git", "add", "README.md"], repoPath);
  sh(["git", "commit", "--quiet", "-m", "chore: fixture repo init"], repoPath);

  return {
    path: repoPath,
    cleanup(): void {
      rmSync(repoPath, { recursive: true, force: true });
    },
  };
}

export function commitFiles(repoPath: string, files: Record<string, string>, subject: string): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repoPath, file)), { recursive: true });
    writeFileSync(path.join(repoPath, file), content);
  }
  sh(["git", "add", "--", ...Object.keys(files)], repoPath);
  sh(["git", "commit", "--quiet", "-m", subject], repoPath);
}

/**
 * Bun runs a root package's own `postinstall` over an empty `bun.lock` — checked live against
 * `crisol-base:0.2.0` — so this install never returns until its container is removed.
 */
export const HANGING_INSTALL: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { postinstall: "sleep 3600" } }),
  "bun.lock": "",
};
