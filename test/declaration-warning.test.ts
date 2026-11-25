import { describe, expect, test } from "bun:test";
import type { Adapter, AdapterContext } from "../src/adapter";
import { ProviderFailureError } from "../src/adapter";
import { DEFAULT_SCRIPT, FakeAdapter } from "../src/adapters/fake";
import type { FakeSession } from "../src/adapters/fake";
import { parseSecretNamesArray } from "../src/config";
import { crisolChangeWarnings, DECLARATION_EFFECTS, declarationChangeWarning } from "../src/declaration-warning";
import { discoverGitRoot } from "../src/git";
import { runRepoPath, runResultPath } from "../src/paths";
import { recover } from "../src/recover";
import { run } from "../src/run";
import type { RunResult } from "../src/run";
import { createTempHome } from "./support/crisolHome";
import { commitFiles, createFixtureRepo } from "./support/fixtureRepo";
import { onlyRunId, readResult, refSha } from "./support/runState";
import { readFileSync, writeFileSync } from "node:fs";

function commitDeclaration(file: string, content: string): string[] {
  return [
    `mkdir -p .crisol && printf '%s\\n' '${content}' > ${file}`,
    `git add ${file}`,
    `git commit --quiet -m 'chore: declare something'`,
  ];
}

describe("declarationChangeWarning names the file and who reads it", () => {
  test("the message says a Run cut from the branch reads it, as the merged repo does", () => {
    const warning = declarationChangeWarning(".crisol/Dockerfile", "it is built");
    expect(warning).toContain(".crisol/Dockerfile");
    expect(warning).toContain("a Run cut from this branch, or the repo once it is merged");
  });
});

describe("a branch that changes a .crisol/ declaration is flagged", () => {
  const cases = [
    { file: ".crisol/config.toml", content: 'env = ["GITHUB_TOKEN"]' },
    { file: ".crisol/Dockerfile", content: "FROM scratch" },
    { file: ".crisol/services.yml", content: "services: {}" },
  ];

  for (const { file, content } of cases) {
    test(`a commit to ${file} carries a warning naming it`, async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({
          task: "x",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(commitDeclaration(file, content)),
        });
        const named = result.warnings.filter((entry) => entry.includes(file));
        expect(named).toHaveLength(1);
        expect(named[0]).toContain("a Run cut from this branch");
        expect(result.warnings.filter((entry) => entry.includes(".crisol/") && !entry.includes(file))).toEqual([]);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    }, 60_000);
  }

  test("a branch that leaves .crisol/ alone carries none of them", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({ task: "x", cwd: repo.path, home: home.path });
      expect(result.warnings.filter((entry) => entry.includes(".crisol/"))).toEqual([]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("the config.toml effect names the key Crisol reads", () => {
  test("it says `env` copies variables from the host environment, since parseSecretNamesArray reads that key", () => {
    const config = DECLARATION_EFFECTS.find((entry) => entry.file === ".crisol/config.toml");
    expect(config?.effect).toContain("`env`");
    expect(config?.effect).not.toContain("secrets");
    expect(parseSecretNamesArray('env = ["X"]')).toEqual(["X"]);
    expect(parseSecretNamesArray('secrets = ["X"]')).toEqual([]);
  });
});

function git(repoPath: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString("utf8")}`);
  return proc.stdout.toString("utf8").trim();
}

function endingBadly(script: readonly string[], howItEnds: (ctx: AdapterContext) => Promise<never>): Adapter {
  const inner = new FakeAdapter(script);
  return {
    name: "fake",
    declarePreStart: () => inner.declarePreStart(),
    async launch(ctx: AdapterContext) {
      await inner.launch(ctx);
      return howItEnds(ctx);
    },
    reportCompletion: (ctx: AdapterContext) => inner.reportCompletion(ctx),
    resumeWithFeedback: (ctx: AdapterContext, feedback: string) => inner.resumeWithFeedback(ctx, feedback),
  };
}

describe("a Run that ends short still reports the .crisol/ change its branch carries to the host", () => {
  const endings = [
    { name: "an error", reason: "error: the agent crashed", end: async (): Promise<never> => { throw new Error("the agent crashed"); } },
    {
      name: "a provider failure",
      reason: "provider: rate limit",
      end: async (): Promise<never> => { throw new ProviderFailureError("rate limit"); },
    },
  ];

  for (const { name, reason, end } of endings) {
    test(`${name} after the agent committed .crisol/config.toml leaves the warning in the result`, async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const error = await run({
          task: "x",
          cwd: repo.path,
          home: home.path,
          adapter: endingBadly(commitDeclaration(".crisol/config.toml", 'env = ["GITHUB_TOKEN"]'), end),
        }).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        // A provider failure resolves and an error rejects; either way the result file is the record.
        if (name === "an error") expect(error).toBeInstanceOf(Error);
        const result = readResult(onlyRunId(home.path), home.path)!;

        expect(result.status).toBe("not-converged");
        expect(result.reason).toBe(reason);
        expect(result.fetchBack).toBe(true);
        expect(refSha(repo.path, result.branch)).toBeDefined();
        expect(result.warnings.filter((entry) => entry.includes(".crisol/config.toml"))).toHaveLength(1);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    }, 60_000);
  }

  test("an interrupt after the agent committed .crisol/config.toml leaves the warning in the result", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      // The Run's own handler, which an in-process emit reaches the same way the OS does.
      const adapter = endingBadly(commitDeclaration(".crisol/config.toml", 'env = ["GITHUB_TOKEN"]'), () => {
        process.emit("SIGINT");
        return new Promise<never>(() => {});
      });
      await run({ task: "x", cwd: repo.path, home: home.path, adapter }).catch(() => undefined);
      const result = readResult(onlyRunId(home.path), home.path)!;

      expect(result.reason).toContain("interrupted");
      expect(result.fetchBack).toBe(true);
      expect(result.warnings.filter((entry) => entry.includes(".crisol/config.toml"))).toHaveLength(1);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("crisol recover reports the .crisol/ change of the branch it fetches back", () => {
  test("a dead Run whose Fetch-back never happened settles with the warning for its commits since its base", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const done = await run({
        task: "x",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter(commitDeclaration(".crisol/services.yml", "services: {}")),
      });
      // Leaves the state of a Run killed after teardown.
      const stored = JSON.parse(readFileSync(runResultPath(done.run, home.path), "utf8")) as RunResult;
      writeFileSync(runResultPath(done.run, home.path), JSON.stringify({ ...stored, fetchBack: false, warnings: [] }, null, 2));
      git(repo.path, ["branch", "--quiet", "-D", done.branch]);
      expect(refSha(repo.path, done.branch)).toBeUndefined();

      const report = await recover(home.path);

      expect(report.outcomes).toContainEqual(expect.objectContaining({ run: done.run, kind: "recovered" }));
      const settled = readResult(done.run, home.path)!;
      expect(settled.fetchBack).toBe(true);
      expect(settled.warnings.filter((entry) => entry.includes(".crisol/services.yml"))).toHaveLength(1);
      expect(refSha(repo.path, done.branch)).toBe(git(runRepoPath(done.run, home.path), ["rev-parse", `refs/heads/${done.branch}`]));
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("a Continuation's result keeps the .crisol/ change of an earlier round", () => {
  test("a Dockerfile committed in round 1 is still reported after round 2 rewrites the result", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const store = "/crisol-fake-sessions";
    try {
      const roundTwo: readonly string[] = ["echo two > TWO.md", "git add TWO.md", "git commit --quiet -m 'feat: round two'"];
      const session: FakeSession = { store, continueScript: roundTwo };
      const first = await run({
        task: "x",
        cwd: repo.path,
        home: home.path,
        name: "feature/keeps-warning",
        adapter: new FakeAdapter(commitDeclaration(".crisol/Dockerfile", "FROM scratch"), undefined, undefined, {}, session),
      });
      expect(first.warnings.filter((entry) => entry.includes(".crisol/Dockerfile"))).toHaveLength(1);

      const second = await run({
        task: "again",
        cwd: repo.path,
        home: home.path,
        continue: "feature/keeps-warning",
        adapter: new FakeAdapter(DEFAULT_SCRIPT, undefined, undefined, {}, session),
      });

      expect(second.run).toBe(first.run);
      expect(second.warnings.filter((entry) => entry.includes(".crisol/Dockerfile"))).toHaveLength(1);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);
});

describe("a branch that deletes a watched file says it removes it", () => {
  test("a Run that deletes .crisol/config.toml reports the removal, and what a Run cut from the branch then lacks", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      commitFiles(repo.path, { ".crisol/config.toml": 'gates = ["true"]\n' }, "chore: declare a Gate");
      const result = await run({
        task: "x",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter(["git rm --quiet .crisol/config.toml", "git commit --quiet -m 'chore: drop the config'"]),
      });

      const named = result.warnings.filter((entry) => entry.includes(".crisol/config.toml"));
      expect(named).toHaveLength(1);
      expect(named[0]).toContain("removes");
      expect(named[0]).toContain("unverified");
      expect(named[0]).toContain("--gate");
      expect(named[0]).not.toContain("are copied");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("each watched file, when removed, names its own effect; editing lines out of it is still a change", () => {
    const repo = createFixtureRepo();
    try {
      const files = {
        ".crisol/config.toml": 'gates = ["true"]\nenv = ["X"]\n',
        ".crisol/Dockerfile": "FROM scratch\n",
        ".crisol/services.yml": "services: {}\n",
        ".crisol/network": "example.org\n",
      };
      commitFiles(repo.path, files, "chore: declare");
      const host = discoverGitRoot(repo.path)!;
      const base = git(host, ["rev-parse", "HEAD"]);
      git(host, ["rm", "--quiet", ...Object.keys(files)]);
      git(host, ["commit", "--quiet", "-m", "chore: drop them"]);

      const warnings = crisolChangeWarnings(host, base, git(host, ["rev-parse", "HEAD"]));

      expect(warnings).toHaveLength(4);
      expect(warnings.every((entry) => entry.includes("removes"))).toBe(true);
      expect(warnings.find((entry) => entry.includes(".crisol/config.toml"))).toContain("unverified");
      expect(warnings.find((entry) => entry.includes(".crisol/Dockerfile"))).toContain("default");
      expect(warnings.find((entry) => entry.includes(".crisol/services.yml"))).toContain("no Services");
      expect(warnings.find((entry) => entry.includes(".crisol/network"))).toContain("built-in");

      git(host, ["checkout", "--quiet", base, "--", "."]);
      commitFiles(host, { ".crisol/config.toml": 'gates = ["true"]\n' }, "chore: drop the env line");
      const edited = crisolChangeWarnings(host, base, git(host, ["rev-parse", "HEAD"]));
      expect(edited).toHaveLength(1);
      expect(edited[0]).toContain("changes");
    } finally {
      repo.cleanup();
    }
  }, 30_000);
});
