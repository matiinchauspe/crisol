import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
