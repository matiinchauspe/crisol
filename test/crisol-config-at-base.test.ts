import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { allowlistByLevel, readRepoLevelAtCommit } from "../src/allowlist";
import { readRepoGates, readRepoSecretNames } from "../src/config";
import { readProjectDockerfile } from "../src/project-layer";
import { readRepoServices } from "../src/services";
import { resolveTemplate } from "../src/task";
import type { RunResult } from "../src/run";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { commitFiles, createFixtureRepo, headSha } from "./support/fixtureRepo";

function git(repoPath: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString("utf8")}`);
}

function writeUncommitted(repoPath: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repoPath, file)), { recursive: true });
    writeFileSync(path.join(repoPath, file), content);
  }
}

describe("a Run reads .crisol/ as its base commits it", () => {
  test("a Gate declared only on --base runs while the host sits on a branch without it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      git(repo.path, "switch", "--quiet", "-c", "previous-ticket");
      commitFiles(repo.path, { ".crisol/config.toml": 'gates = ["exit 1"]\n' }, "chore: declare a Gate");
      git(repo.path, "switch", "--quiet", "main");

      const result = await runCli(
        ["run", "say hello", "--json", "--max-iterations", "1", "--base", "previous-ticket", "--adapter", "fake"],
        { cwd: repo.path, home: home.path },
      );

      const payload = JSON.parse(result.stdout) as RunResult;
      expect(payload.gates).toEqual([{ cmd: "exit 1", ok: false }]);
      expect(payload.status).toBe("not-converged");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a Gate present only as an uncommitted host edit does not run", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeUncommitted(repo.path, { ".crisol/config.toml": 'gates = ["exit 1"]\n' });

      const result = await runCli(["run", "say hello", "--json", "--max-iterations", "1", "--adapter", "fake"], {
        cwd: repo.path,
        home: home.path,
      });

      const payload = JSON.parse(result.stdout) as RunResult;
      expect(payload.gates).toEqual([]);
      expect(payload.status).toBe("unverified");
      expect(result.stderr).toContain("Warning: Uncommitted changes in .crisol/config.toml.");
      expect(result.stderr).toContain("reads .crisol/ as its base commit holds it");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a clean .crisol/ prints no warning", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      commitFiles(repo.path, { ".crisol/config.toml": 'gates = ["true"]\n' }, "chore: declare a Gate");

      const result = await runCli(["run", "say hello", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Uncommitted changes");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a fan-out names an uncommitted .crisol/ file once, and every uncommitted file", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeUncommitted(repo.path, { ".crisol/config.toml": 'gates = ["true"]\n', ".crisol/network": "example.com\n" });

      const result = await runCli(["run", "a", "b", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });

      expect(result.stderr.split("Uncommitted changes")).toHaveLength(2);
      expect(result.stderr).toContain(".crisol/config.toml, .crisol/network");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);

  test("every declaration comes from the base commit, never from the host's working tree or a later commit", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const bare = headSha(repo.path);
      commitFiles(
        repo.path,
        {
          ".crisol/config.toml": 'gates = ["make check"]\nenv = ["BASE_SECRET"]\n',
          ".crisol/network": "base.example.com\n",
          ".crisol/services.yml": "services:\n  db:\n    image: postgres:16-alpine\n",
          ".crisol/Dockerfile": "FROM alpine:3.20\n",
          ".crisol/prompts/fix-bug.md": "BASE: {{task}}",
        },
        "chore: declare .crisol/",
      );
      const base = headSha(repo.path);
      commitFiles(repo.path, { ".crisol/config.toml": 'gates = ["later"]\n' }, "chore: a later Gate");
      writeUncommitted(repo.path, {
        ".crisol/config.toml": 'gates = ["edited"]\nenv = ["EDITED_SECRET"]\n',
        ".crisol/network": "edited.example.com\n",
        ".crisol/services.yml": "services:\n  cache:\n    image: redis:7-alpine\n",
        ".crisol/Dockerfile": "FROM debian:12\n",
        ".crisol/prompts/fix-bug.md": "EDITED: {{task}}",
      });

      expect(readRepoGates(repo.path, base)).toEqual(["make check"]);
      expect(readRepoSecretNames(repo.path, base)).toEqual(["BASE_SECRET"]);
      expect(readRepoLevelAtCommit(repo.path, base)).toEqual(["base.example.com"]);
      expect(allowlistByLevel(home.path, readRepoLevelAtCommit(repo.path, base)).map((entry) => entry.host)).toContain(
        "base.example.com",
      );
      expect(readRepoServices(repo.path, base).map((service) => service.name)).toEqual(["db"]);
      expect(readProjectDockerfile(repo.path, base)).toBe("FROM alpine:3.20\n");
      expect(resolveTemplate("fix-bug", home.path, repo.path, base).text).toBe("BASE: {{task}}");

      expect(readRepoGates(repo.path, bare)).toEqual([]);
      expect(readRepoSecretNames(repo.path, bare)).toEqual([]);
      expect(readRepoLevelAtCommit(repo.path, bare)).toEqual([]);
      expect(readRepoServices(repo.path, bare)).toEqual([]);
      expect(readProjectDockerfile(repo.path, bare)).toBeUndefined();
      expect(resolveTemplate("fix-bug", home.path, repo.path, bare).source).toBe("built-in");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});
