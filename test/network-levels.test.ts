import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FakeAdapter, REACH_UNLISTED_HOST_SCRIPT, WIDEN_REPO_LEVEL_SCRIPT } from "../src/adapters/fake";
import { run } from "../src/run";
import type { RunResult } from "../src/run";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { readLog } from "./support/runState";

const REACH_EXAMPLE_GATE = "curl -fsS --max-time 20 -o /dev/null https://example.com/";

function gitShow(repoPath: string, ref: string, file: string): string {
  const proc = Bun.spawnSync(["git", "-C", repoPath, "show", `${ref}:${file}`], { stdout: "pipe" });
  return proc.stdout.toString("utf8").trim();
}

function repoLevel(repoPath: string): string {
  return path.join(repoPath, ".crisol", "network");
}

describe("crisol allow edits one Allowlist level", () => {
  test("a host added with `crisol allow` becomes reachable on the next Run", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const runArgs = ["run", "x", "--json", "--max-iterations", "1", "--gate", REACH_EXAMPLE_GATE];
      const before = JSON.parse((await runCli(runArgs, { cwd: repo.path, home: home.path })).stdout) as RunResult;
      expect(before.status).toBe("not-converged");
      expect(before.blocked).toEqual([{ host: "example.com", count: 1 }]);

      const allow = await runCli(["allow", "example.com"], { cwd: repo.path, home: home.path });
      expect(allow.exitCode).toBe(0);
      expect(allow.stdout).toContain("example.com");

      const after = JSON.parse((await runCli(runArgs, { cwd: repo.path, home: home.path })).stdout) as RunResult;
      expect(after.status).toBe("verified");
      expect(after.blocked).toEqual([]);
      expect(after.network).toBe("allowlist");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);

  test("`crisol allow <host> --repo` writes the repo level; the user level is untouched", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const allow = await runCli(["allow", "api.stripe.com", "--repo"], { cwd: repo.path, home: home.path });
      expect(allow.exitCode).toBe(0);
      expect(readFileSync(repoLevel(repo.path), "utf8")).toBe("api.stripe.com\n");
      expect(existsSync(path.join(home.path, "network"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("the user level is written under CRISOL_HOME, and the repo is untouched", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const allow = await runCli(["allow", "api.stripe.com"], { cwd: repo.path, home: home.path });
      expect(allow.exitCode).toBe(0);
      expect(readFileSync(path.join(home.path, "network"), "utf8")).toBe("api.stripe.com\n");
      expect(existsSync(path.join(repo.path, ".crisol"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("a host with an inline `# comment` on the user level is reachable on the next Run", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "network"), "example.com # the docs site\n");
      const result = JSON.parse(
        (await runCli(["run", "x", "--json", "--max-iterations", "1", "--gate", REACH_EXAMPLE_GATE], {
          cwd: repo.path,
          home: home.path,
        })).stdout,
      ) as RunResult;
      expect(result.status).toBe("verified");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test.each(["a$(id)b.com", "1.2.3.4", "*.example.com"])(
    "`crisol allow %p` is refused and writes nothing",
    async (host) => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const allow = await runCli(["allow", host], { cwd: repo.path, home: home.path });
        expect(allow.exitCode).toBe(1);
        expect(allow.stderr).toContain("plain hostname");
        expect(existsSync(path.join(home.path, "network"))).toBe(false);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
  );

  test("`crisol allow` reports the host as it was written, normalized", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const allow = await runCli(["allow", " Foo.COM "], { cwd: repo.path, home: home.path });
      expect(allow.exitCode).toBe(0);
      expect(allow.stdout).toStartWith("Added foo.com to the user Allowlist");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("`crisol allow host.docker.internal` is refused: it names the Docker host", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const allow = await runCli(["allow", "host.docker.internal", "--repo"], { cwd: repo.path, home: home.path });
      expect(allow.exitCode).toBe(1);
      expect(allow.stderr).toContain("inside");
      expect(existsSync(path.join(repo.path, ".crisol"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("`crisol allow --repo` from a subdirectory writes the repo root's level", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      mkdirSync(path.join(repo.path, "src", "deep"), { recursive: true });
      const allow = await runCli(["allow", "sentry.io", "--repo"], {
        cwd: path.join(repo.path, "src", "deep"),
        home: home.path,
      });
      expect(allow.exitCode).toBe(0);
      expect(readFileSync(repoLevel(repo.path), "utf8")).toBe("sentry.io\n");
      expect(existsSync(path.join(repo.path, "src", "deep", ".crisol"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("`crisol allow --repo` outside a git repo fails and writes nothing", async () => {
    const home = createTempHome();
    const outside = createTempHome();
    try {
      const allow = await runCli(["allow", "sentry.io", "--repo"], { cwd: outside.path, home: home.path });
      expect(allow.exitCode).toBe(1);
      expect(allow.stderr).toContain("Not inside a git repo");
      expect(existsSync(path.join(outside.path, ".crisol"))).toBe(false);
    } finally {
      home.cleanup();
      outside.cleanup();
    }
  });

  test("`crisol allow` with no host is a usage error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const allow = await runCli(["allow"], { cwd: repo.path, home: home.path });
      expect(allow.exitCode).toBe(1);
      expect(allow.stderr).toContain("Usage: crisol allow <host> [--repo]");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("a Run whose user level holds a non-hostname fails before anything is left behind", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "network"), "a$(id)b.com\n");
      const result = await runCli(["run", "x", "--json"], { cwd: repo.path, home: home.path });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('"a$(id)b.com" is not a plain hostname');
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("--network learn and --network open", () => {
  test("`--network bogus` is a usage error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "x", "--network", "bogus"], { cwd: repo.path, home: home.path });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--network must be one of allowlist, learn, open");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("`--network learn` lets a host through, records it, and the result carries \"learn\"", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({
        task: "reach a host off the Allowlist",
        cwd: repo.path,
        home: home.path,
        network: "learn",
        adapter: new FakeAdapter(REACH_UNLISTED_HOST_SCRIPT),
      });
      expect(result.network).toBe("learn");
      expect(gitShow(repo.path, result.branch, "UNLISTED.txt")).toBe("reached a host off the Allowlist");
      expect(result.reached).toEqual([{ host: "example.com", count: 2 }]);
      expect(result.blocked).toEqual([]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a learn Run prints a `crisol allow --repo` line per new host, asks nothing and writes nothing", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const cli = await runCli(["run", "x", "--network", "learn", "--gate", REACH_EXAMPLE_GATE], {
        cwd: repo.path,
        home: home.path,
      });
      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).toContain("  crisol allow example.com --repo\n");
      expect(cli.stdout).not.toContain("[y/N]");
      expect(existsSync(path.join(repo.path, ".crisol"))).toBe(false);
      expect(existsSync(path.join(home.path, "network"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a host on the user level is still proposed for the repo level, so teammates get it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "network"), "example.com\n");
      const cli = await runCli(["run", "x", "--network", "learn", "--gate", REACH_EXAMPLE_GATE], {
        cwd: repo.path,
        home: home.path,
      });
      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).toContain("  crisol allow example.com --repo\n");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a host already on the repo level is not proposed again", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      mkdirSync(path.join(repo.path, ".crisol"), { recursive: true });
      writeFileSync(repoLevel(repo.path), "example.com\n");
      const cli = await runCli(["run", "x", "--network", "learn", "--gate", REACH_EXAMPLE_GATE], {
        cwd: repo.path,
        home: home.path,
      });
      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).not.toContain("crisol allow");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a Fan-out of learn Runs proposes each host once, across every Run", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const cli = await runCli(["run", "a", "b", "--network", "learn", "--gate", REACH_EXAMPLE_GATE], {
        cwd: repo.path,
        home: home.path,
      });
      expect(cli.exitCode).toBe(0);
      expect(cli.stdout.split("crisol allow example.com --repo")).toHaveLength(2);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);

  test("a learn Run with an unreadable repo level prints the error instead of proposals", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      mkdirSync(path.join(repo.path, ".crisol"), { recursive: true });
      writeFileSync(repoLevel(repo.path), "example.com\nnot a host\n");
      const cli = await runCli(["run", "x", "--network", "learn", "--gate", REACH_EXAMPLE_GATE], {
        cwd: repo.path,
        home: home.path,
      });
      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).not.toContain("crisol allow");
      expect(cli.stderr).toContain('"not a host" is not a plain hostname');
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("with --json a learn Run prints only its Run result, which carries `reached`", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const cli = await runCli(["run", "x", "--json", "--network", "learn", "--gate", REACH_EXAMPLE_GATE], {
        cwd: repo.path,
        home: home.path,
      });
      expect(cli.exitCode).toBe(0);
      const lines = cli.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      const result = JSON.parse(lines[0]!) as RunResult;
      expect(result.network).toBe("learn");
      expect(result.reached).toEqual([{ host: "example.com", count: 1 }]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("`--network open` reads neither level, so a bad line in one cannot break it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "network"), "not a host\n");
      mkdirSync(path.join(repo.path, ".crisol"), { recursive: true });
      writeFileSync(repoLevel(repo.path), "a$(id)b.com\n");
      const cli = await runCli(["run", "x", "--json", "--network", "open", "--gate", REACH_EXAMPLE_GATE], {
        cwd: repo.path,
        home: home.path,
      });
      expect(cli.exitCode).toBe(0);
      const result = JSON.parse(cli.stdout) as RunResult;
      expect(result.network).toBe("open");
      expect(result.status).toBe("verified");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("`--network open` never builds the proxy image", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({
        task: "x",
        cwd: repo.path,
        home: home.path,
        network: "open",
        ensureProxyImage: async () => {
          throw new Error("an open Run must not build the proxy image");
        },
      });
      expect(result.network).toBe("open");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("`--network open` reaches a non-listed host with no wall, and the result carries \"open\"", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({
        task: "reach a host off the Allowlist",
        cwd: repo.path,
        home: home.path,
        network: "open",
        adapter: new FakeAdapter(REACH_UNLISTED_HOST_SCRIPT),
      });
      expect(result.network).toBe("open");
      expect(result.blocked).toEqual([]);
      expect(gitShow(repo.path, result.branch, "UNLISTED.txt")).toBe("reached a host off the Allowlist");
      expect(readLog(result.run, home.path)).toContain("network open: no wall");
      expect(readLog(result.run, home.path)).not.toContain("network wall up");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("the repo level is made visible", () => {
  test("the Run log names every non-built-in host and the level that brought it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "network"), "api.stripe.com\n");
      mkdirSync(path.join(repo.path, ".crisol"), { recursive: true });
      writeFileSync(repoLevel(repo.path), "sentry.io # errors\n");
      const result = await run({ task: "x", cwd: repo.path, home: home.path });
      const log = readLog(result.run, home.path);
      expect(log).toContain("user: api.stripe.com");
      expect(log).toContain("repo: sentry.io");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a branch that adds a host to .crisol/network carries a warning naming it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({
        task: "x",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter(WIDEN_REPO_LEVEL_SCRIPT),
      });
      const warning = result.warnings.find((entry) => entry.includes(".crisol/network"));
      expect(warning).toBeDefined();
      expect(warning).toContain('"evil.example.com"');
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("plain-text output prints each Run's warnings to stderr, a Fan-out's included", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      // A Gate is the CLI's only way to run a command inside the Sandbox; the default fake Adapter
      // cannot be pointed at another script.
      const widen = WIDEN_REPO_LEVEL_SCRIPT.join(" && ");
      const cli = await runCli(["run", "a", "b", "--gate", widen], { cwd: repo.path, home: home.path });
      expect(cli.exitCode).toBe(0);
      const warnings = cli.stderr.split("\n").filter((line) => line.startsWith("Warning: ") && line.includes('"evil.example.com"'));
      expect(warnings).toHaveLength(2);
      expect(cli.stdout).not.toContain("Warning:");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);

  test("a branch that leaves .crisol/network alone carries no such warning", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({ task: "x", cwd: repo.path, home: home.path });
      expect(result.warnings.filter((entry) => entry.includes(".crisol/network"))).toEqual([]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});
