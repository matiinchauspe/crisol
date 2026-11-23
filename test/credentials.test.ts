import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Adapter } from "../src/adapter";
import { parseSecretNamesArray } from "../src/config";
import { run } from "../src/run";
import type { SecretStore } from "../src/secret-store";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { runCli } from "./support/cli";

describe("parseSecretNamesArray (ticket 08, .crisol/config.toml's env key)", () => {
  test("parses a single-line double-quoted string array", () => {
    expect(parseSecretNamesArray('env = ["NPM_TOKEN", "OTHER_TOKEN"]')).toEqual([
      "NPM_TOKEN",
      "OTHER_TOKEN",
    ]);
  });

  test("returns [] when there is no env key at all", () => {
    expect(parseSecretNamesArray('gates = ["bun test"]')).toEqual([]);
  });

  test("returns [] for an empty array", () => {
    expect(parseSecretNamesArray("env = []")).toEqual([]);
  });

  test("gates and env coexist in the same file without interfering with each other", () => {
    const text = ['gates = ["bun test"]', 'env = ["NPM_TOKEN"]'].join("\n");
    expect(parseSecretNamesArray(text)).toEqual(["NPM_TOKEN"]);
  });
});

/** A fake, in-memory `SecretStore` — the Keychain is never touched in this suite. */
function fakeSecretStore(seed: Record<string, string> = {}): SecretStore {
  const values = new Map(Object.entries(seed));
  return {
    get: (name) => values.get(name),
    set: (name, value) => {
      values.set(name, value);
    },
  };
}

function declareSecret(name: string): Adapter {
  return {
    declarePreStart() {
      return { envNames: [name], mounts: [] };
    },
    async launch() {},
    async reportCompletion() {
      return true;
    },
    async resumeWithFeedback() {},
  };
}

describe("least privilege: only the Adapter-declared and repo-declared names ever reach the Sandbox", () => {
  test("a repo-declared secret (host env) and an Adapter-declared secret (SecretStore) both land correctly; an undeclared host env var never does", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    mkdirSync(path.join(repo.path, ".crisol"));
    writeFileSync(path.join(repo.path, ".crisol", "config.toml"), 'env = ["REPO_SECRET"]\n');
    process.env.REPO_SECRET = "repo-secret-value";
    process.env.CRISOL_TEST_UNRELATED = "should-never-leak";
    try {
      const probeScript = [
        'printenv REPO_SECRET > probe.txt || echo "REPO_SECRET=ABSENT" >> probe.txt',
        'printenv ADAPTER_SECRET >> probe.txt || echo "ADAPTER_SECRET=ABSENT" >> probe.txt',
        'printenv CRISOL_TEST_UNRELATED >> probe.txt && echo "UNRELATED=LEAKED" >> probe.txt ' +
          '|| echo "UNRELATED=ABSENT" >> probe.txt',
        "git add probe.txt",
        "git commit --quiet -m 'test: credentials probe'",
      ];
      const adapter: Adapter = {
        declarePreStart() {
          return { envNames: ["ADAPTER_SECRET"], mounts: [] };
        },
        async launch(ctx) {
          const result = await ctx.sandbox.exec(["bash", "-c", probeScript.join("\n")]);
          if (result.exitCode !== 0) throw new Error(`probe failed: ${result.stderr}`);
        },
        async reportCompletion() {
          return true;
        },
        async resumeWithFeedback() {},
      };

      const result = await run({
        task: "probe declared secrets",
        cwd: repo.path,
        home: home.path,
        adapter,
        secretStore: fakeSecretStore({ ADAPTER_SECRET: "adapter-secret-value" }),
      });

      const probeText = Bun.spawnSync(
        ["git", "-C", repo.path, "show", `${result.branch}:probe.txt`],
        { stdout: "pipe" },
      ).stdout.toString("utf8");

      expect(probeText).toContain("repo-secret-value");
      expect(probeText).toContain("adapter-secret-value");
      expect(probeText).toContain("UNRELATED=ABSENT");
      expect(probeText).not.toContain("should-never-leak");
    } finally {
      delete process.env.REPO_SECRET;
      delete process.env.CRISOL_TEST_UNRELATED;
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("a repo-declared secret missing from the host env (failure path)", () => {
  test("fails before any side effect, naming it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    mkdirSync(path.join(repo.path, ".crisol"));
    writeFileSync(path.join(repo.path, ".crisol", "config.toml"), 'env = ["CRISOL_TEST_MISSING"]\n');
    delete process.env.CRISOL_TEST_MISSING;
    try {
      const result = await runCli(["run", "say hello", "--json", "--adapter", "fake"], {
        cwd: repo.path,
        home: home.path,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("CRISOL_TEST_MISSING");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("an Adapter-declared secret missing from SecretStore (failure path)", () => {
  test("fails before any side effect, naming it and pointing at `crisol auth`", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      let caught: unknown;
      try {
        await run({
          task: "x",
          cwd: repo.path,
          home: home.path,
          adapter: declareSecret("CRISOL_NEVER_AUTHED"),
          secretStore: fakeSecretStore(),
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("CRISOL_NEVER_AUTHED");
      expect((caught as Error).message).toContain("crisol auth");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 30_000);
});

describe("nothing from $HOME is mounted or visible inside the Sandbox (spec, Credentials)", () => {
  test("~/.gitconfig, ~/.ssh, ~/.config/gh, ~/.aws and ~/.claude are all absent inside", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const probeScript = [
        'test ! -e "$HOME/.gitconfig" && echo GITCONFIG_ABSENT >> home_probe.txt || echo GITCONFIG_PRESENT >> home_probe.txt',
        'test ! -e "$HOME/.ssh" && echo SSH_ABSENT >> home_probe.txt || echo SSH_PRESENT >> home_probe.txt',
        'test ! -e "$HOME/.config/gh" && echo GH_ABSENT >> home_probe.txt || echo GH_PRESENT >> home_probe.txt',
        'test ! -e "$HOME/.aws" && echo AWS_ABSENT >> home_probe.txt || echo AWS_PRESENT >> home_probe.txt',
        'test ! -e "$HOME/.claude" && echo CLAUDE_ABSENT >> home_probe.txt || echo CLAUDE_PRESENT >> home_probe.txt',
        "git add home_probe.txt",
        "git commit --quiet -m 'test: home containment probe'",
      ];

      const result = await run({
        task: "home containment probe",
        cwd: repo.path,
        home: home.path,
        adapter: {
          declarePreStart() {
            return { envNames: [], mounts: [] };
          },
          async launch(ctx) {
            const probe = await ctx.sandbox.exec(["bash", "-c", probeScript.join("\n")]);
            if (probe.exitCode !== 0) throw new Error(`probe failed: ${probe.stderr}`);
          },
          async reportCompletion() {
            return true;
          },
          async resumeWithFeedback() {},
        },
      });

      const probeText = Bun.spawnSync(
        ["git", "-C", repo.path, "show", `${result.branch}:home_probe.txt`],
        { stdout: "pipe" },
      ).stdout.toString("utf8");

      for (const marker of ["GITCONFIG", "SSH", "GH", "AWS", "CLAUDE"]) {
        expect(probeText).toContain(`${marker}_ABSENT`);
        expect(probeText).not.toContain(`${marker}_PRESENT`);
      }
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("no push is possible from inside the Sandbox (spec, Credentials)", () => {
  test("git push fails — the Clone's own remote path isn't mounted inside", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const probeScript = [
        "(git push origin HEAD 2>push_error.txt && echo PUSH_SUCCEEDED > push_probe.txt) " +
          "|| echo PUSH_BLOCKED > push_probe.txt",
        "git add push_probe.txt",
        "git commit --quiet -m 'test: push probe'",
      ];

      const result = await run({
        task: "push probe",
        cwd: repo.path,
        home: home.path,
        adapter: {
          declarePreStart() {
            return { envNames: [], mounts: [] };
          },
          async launch(ctx) {
            const probe = await ctx.sandbox.exec(["bash", "-c", probeScript.join("\n")]);
            if (probe.exitCode !== 0) throw new Error(`probe failed: ${probe.stderr}`);
          },
          async reportCompletion() {
            return true;
          },
          async resumeWithFeedback() {},
        },
      });

      const probeText = Bun.spawnSync(
        ["git", "-C", repo.path, "show", `${result.branch}:push_probe.txt`],
        { stdout: "pipe" },
      ).stdout.toString("utf8");

      expect(probeText.trim()).toBe("PUSH_BLOCKED");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});
