import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { readRepoGates } from "../src/config";
import { detectGates, SANDBOX_BLOCK } from "../src/init";
import type { RunResult } from "../src/run";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

function commitFile(repoPath: string, file: string, content: string): void {
  writeFileSync(path.join(repoPath, file), content);
  Bun.spawnSync(["git", "-C", repoPath, "add", file]);
  Bun.spawnSync(["git", "-C", repoPath, "commit", "--quiet", "-m", `chore: add ${file}`]);
}

function packageJson(scripts: Record<string, string>): string {
  return JSON.stringify({ name: "fixture", private: true, scripts }, null, 2);
}

function countBlocks(text: string): number {
  return text.split("\n").filter((line) => line === "## Sandbox").length;
}

function declaredCommands(block: string): string[] {
  return [...block.matchAll(/`(crisol run [^`]+)`/g)].map((match) => match[1]!);
}

/** Splits on spaces, keeping a double-quoted argument whole, as a shell would for these lines. */
function shellWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!);
}

describe("detectGates", () => {
  test("names each of typecheck, lint and test the scripts declare, run with the lockfile's manager", () => {
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "package.json"), packageJson({ test: "bun test", typecheck: "tsc", dev: "vite" }));
      expect(detectGates(repo.path)).toEqual(["npm run typecheck", "npm run test"]);
      writeFileSync(path.join(repo.path, "bun.lock"), "");
      expect(detectGates(repo.path)).toEqual(["bun run typecheck", "bun run test"]);
    } finally {
      repo.cleanup();
    }
  });

  test("skips npm init's placeholder test script, which exits 1 on purpose, and a repo with no package.json", () => {
    const repo = createFixtureRepo();
    try {
      expect(detectGates(repo.path)).toEqual([]);
      writeFileSync(
        path.join(repo.path, "package.json"),
        packageJson({ test: 'echo "Error: no test specified" && exit 1' }),
      );
      expect(detectGates(repo.path)).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });
});

describe("crisol init", () => {
  test("in a repo with test and typecheck scripts, .crisol/ lists both as Gates, an empty network file and no services", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "package.json"), packageJson({ test: "bun test", typecheck: "bun check" }));
      writeFileSync(path.join(repo.path, "bun.lock"), "");

      const result = await runCli(["init"], { cwd: repo.path, home: home.path });

      expect(result.exitCode).toBe(0);
      expect(readRepoGates(repo.path)).toEqual(["bun run typecheck", "bun run test"]);
      expect(readFileSync(path.join(repo.path, ".crisol", "network"), "utf8")).toBe("");
      expect(existsSync(path.join(repo.path, ".crisol", "services.yml"))).toBe(false);
      expect(result.stdout).toContain("Gates: bun run typecheck, bun run test");
      expect(result.stdout).toContain("No learn Run.");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("a second init keeps an edited .crisol/ as it is", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      await runCli(["init"], { cwd: repo.path, home: home.path });
      writeFileSync(path.join(repo.path, ".crisol", "config.toml"), 'gates = ["make check"]\n');
      writeFileSync(path.join(repo.path, ".crisol", "network"), "api.stripe.com\n");

      const again = await runCli(["init"], { cwd: repo.path, home: home.path });

      expect(again.exitCode).toBe(0);
      expect(readRepoGates(repo.path)).toEqual(["make check"]);
      expect(readFileSync(path.join(repo.path, ".crisol", "network"), "utf8")).toBe("api.stripe.com\n");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("appends the Sandbox block to AGENTS.md when present, leaves CLAUDE.md alone, and never duplicates it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "AGENTS.md"), "# Agents\n\nUse bun.");
      writeFileSync(path.join(repo.path, "CLAUDE.md"), "# Claude\n");

      await runCli(["init"], { cwd: repo.path, home: home.path });
      const again = await runCli(["init"], { cwd: repo.path, home: home.path });

      const agents = readFileSync(path.join(repo.path, "AGENTS.md"), "utf8");
      expect(agents).toBe(`# Agents\n\nUse bun.\n\n${SANDBOX_BLOCK}`);
      expect(countBlocks(agents)).toBe(1);
      expect(readFileSync(path.join(repo.path, "CLAUDE.md"), "utf8")).toBe("# Claude\n");
      expect(again.stdout).toContain("AGENTS.md already declares a ## Sandbox block");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("appends the Sandbox block to CLAUDE.md when there is no AGENTS.md, and never duplicates it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "CLAUDE.md"), "# Claude\n");

      await runCli(["init"], { cwd: repo.path, home: home.path });
      await runCli(["init"], { cwd: repo.path, home: home.path });

      const claude = readFileSync(path.join(repo.path, "CLAUDE.md"), "utf8");
      expect(claude).toBe(`# Claude\n\n${SANDBOX_BLOCK}`);
      expect(countBlocks(claude)).toBe(1);
      expect(existsSync(path.join(repo.path, "AGENTS.md"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("creates AGENTS.md holding only the block when the repo has neither file", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      await runCli(["init"], { cwd: repo.path, home: home.path });
      expect(readFileSync(path.join(repo.path, "AGENTS.md"), "utf8")).toBe(SANDBOX_BLOCK);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("refuses an unknown argument and a directory outside any git repo", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const unknown = await runCli(["init", "--yes"], { cwd: repo.path, home: home.path });
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain("Usage: crisol init");
      const outside = await runCli(["init"], { cwd: home.path, home: home.path });
      expect(outside.exitCode).toBe(1);
      expect(outside.stderr).toContain("Not inside a git repo");
      expect(existsSync(path.join(home.path, ".crisol"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test(
    "accepting the learn offer runs a learn-mode Run and writes the hosts it reached to the repo level",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        // The Gate is what reaches the network: the stand-in Adapter itself never does.
        commitFile(repo.path, "package.json", packageJson({ test: "curl -fsS --max-time 20 -o /dev/null https://example.com/" }));

        const result = await runCli(["init", "--adapter", "fake"], { cwd: repo.path, home: home.path, stdin: "y\n" });

        expect(result.stdout).toMatch(/Run \w+: branch crisol\/\w+, status verified\./);
        expect(result.stdout).toContain("Added example.com to the repo Allowlist (.crisol/network).");
        expect(readFileSync(path.join(repo.path, ".crisol", "network"), "utf8")).toBe("example.com\n");
        expect(result.exitCode).toBe(0);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    180_000,
  );
});

describe("the entry points the Sandbox block declares", () => {
  test(
    "run as written returns a Run result with branch, status and finalMessage, and continue takes up that same Run",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        await runCli(["init"], { cwd: repo.path, home: home.path });
        const block = readFileSync(path.join(repo.path, "AGENTS.md"), "utf8");
        const [runLine, continueLine] = declaredCommands(block);
        writeFileSync(path.join(repo.path, "package.md"), "Say hello.\n");
        writeFileSync(path.join(repo.path, "request.md"), "Say it again.\n");

        // The one substitution: the suite never calls a model, so the declared Claude Code Adapter
        // becomes the stand-in. Every other flag runs exactly as the block writes it.
        const asCli = (line: string) =>
          shellWords(line.replace("--adapter claude-code", "--adapter fake")).slice(1);
        expect(runLine).toContain("--adapter claude-code");
        expect(continueLine).toContain("--adapter claude-code");

        const started = await runCli(
          asCli(
            runLine!
              .replace("<package>", "package.md")
              .replace("<ref>", "main")
              .replace("<branch>", "ticket/17")
              .replace("<cmd>", "test -f CRISOL_RUN.md"),
          ),
          { cwd: repo.path, home: home.path },
        );
        expect(started.exitCode).toBe(0);
        const first = JSON.parse(started.stdout) as RunResult;
        expect(first).toMatchObject({ branch: "ticket/17", status: "verified" });
        expect(typeof first.finalMessage).toBe("string");

        const continued = await runCli(
          asCli(continueLine!.replace("<branch>", "ticket/17").replace("<request>", "request.md")),
          { cwd: repo.path, home: home.path },
        );
        expect(continued.exitCode).toBe(0);
        const second = JSON.parse(continued.stdout) as RunResult;
        expect(second).toMatchObject({ run: first.run, branch: "ticket/17", status: "verified" });
        expect(typeof second.finalMessage).toBe("string");
        expect(second.finishedAt).toBeGreaterThanOrEqual(first.finishedAt);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    180_000,
  );
});
