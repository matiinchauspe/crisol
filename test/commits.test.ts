import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Adapter } from "../src/adapter";
import { CO_AUTHORED_SCRIPT, FakeAdapter } from "../src/adapters/fake";
import { scanCommitsForWarnings } from "../src/git";
import { run } from "../src/run";
import { createFixtureRepo } from "./support/fixtureRepo";
import { createTempHome } from "./support/crisolHome";

function sh(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`\`${args.join(" ")}\` failed in ${cwd}: ${proc.stderr.toString("utf8")}`);
  }
  return proc.stdout.toString("utf8").trim();
}

function commitIdentity(repoPath: string, ref: string): { author: string; committer: string } {
  const [author, committer] = sh(
    ["git", "-C", repoPath, "log", "-1", "--format=%an <%ae>\x1f%cn <%ce>", ref],
    repoPath,
  ).split("\x1f");
  return { author: author ?? "", committer: committer ?? "" };
}

function commitMessage(repoPath: string, ref: string): string {
  return sh(["git", "-C", repoPath, "log", "-1", "--format=%B", ref], repoPath);
}

function shortSha(repoPath: string, ref: string): string {
  return sh(["git", "-C", repoPath, "log", "-1", "--format=%h", ref], repoPath);
}

const SILENT_ADAPTER: Pick<Adapter, "declarePreStart" | "reportCompletion" | "resumeWithFeedback"> = {
  declarePreStart() {
    return { envNames: [], mounts: [] };
  },
  async reportCompletion() {
    return true;
  },
  async resumeWithFeedback() {},
};

describe("commits carry the host repo's identity (ticket 09, spec Commits q16)", () => {
  test("the FakeAdapter's commit is authored and committed as the host's configured identity", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({
        task: "say hello",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter(),
      });

      const { author, committer } = commitIdentity(repo.path, result.branch);
      expect(author).toBe("Crisol Fixture <fixture@crisol.test>");
      expect(committer).toBe("Crisol Fixture <fixture@crisol.test>");
      expect(result.warnings).toEqual([]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("an AI attribution trailer is flagged, never rewritten (ticket 09, spec Commits q16)", () => {
  test('a "Co-Authored-By" trailer becomes a warnings entry naming the commit; the commit itself is unchanged', async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await run({
        task: "say hello",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter(CO_AUTHORED_SCRIPT),
      });

      const sha = shortSha(repo.path, result.branch);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(sha);
      expect(result.warnings[0]).toContain("attribution");

      // Crisol never rewrites commits — the trailer is still exactly there.
      expect(commitMessage(repo.path, result.branch)).toContain(
        "Co-Authored-By: Claude <noreply@anthropic.com>",
      );
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("~/.crisol/instructions.md reaches the Adapter as instructions (ticket 09)", () => {
  test("present content is passed through AdapterContext.instructions", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    writeFileSync(
      path.join(home.path, "instructions.md"),
      "Write conventional commits, in English.\n",
    );
    try {
      let seen: string | undefined;
      const adapter: Adapter = {
        ...SILENT_ADAPTER,
        async launch(ctx) {
          seen = ctx.instructions;
        },
      };

      await run({ task: "probe instructions", cwd: repo.path, home: home.path, adapter });

      expect(seen).toBe("Write conventional commits, in English.\n");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("an absent file leaves instructions undefined — not an error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      let seen: string | undefined = "not yet set";
      const adapter: Adapter = {
        ...SILENT_ADAPTER,
        async launch(ctx) {
          seen = ctx.instructions;
        },
      };

      await run({ task: "probe instructions absence", cwd: repo.path, home: home.path, adapter });

      expect(seen).toBeUndefined();
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("the global ~/.claude/CLAUDE.md is never visible inside the Sandbox (ticket 09)", () => {
  test("its path does not exist, even with instructions.md present (existence only — its content is never read)", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    writeFileSync(path.join(home.path, "instructions.md"), "irrelevant for this probe\n");
    try {
      const probeScript = [
        'test ! -e "$HOME/.claude/CLAUDE.md" && echo CLAUDE_MD_ABSENT >> claude_md_probe.txt ' +
          '|| echo CLAUDE_MD_PRESENT >> claude_md_probe.txt',
        "git add claude_md_probe.txt",
        "git commit --quiet -m 'test: CLAUDE.md visibility probe'",
      ];

      const result = await run({
        task: "CLAUDE.md visibility probe",
        cwd: repo.path,
        home: home.path,
        adapter: new FakeAdapter(probeScript),
      });

      const probeText = sh(
        ["git", "-C", repo.path, "show", `${result.branch}:claude_md_probe.txt`],
        repo.path,
      );
      expect(probeText).toBe("CLAUDE_MD_ABSENT");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("scanCommitsForWarnings (ticket 09, pure function)", () => {
  function commitAs(repoPath: string, name: string, email: string, message: string): void {
    const proc = Bun.spawnSync(
      ["git", "-C", repoPath, "commit", "--quiet", "--allow-empty", `--author=${name} <${email}>`, "-m", message],
      {
        env: { ...process.env, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (proc.exitCode !== 0) {
      throw new Error(`commit failed: ${proc.stderr.toString("utf8")}`);
    }
  }

  const HOST_IDENTITY = { name: "Crisol Fixture", email: "fixture@crisol.test" };

  test("no commits in the range yields no warnings", () => {
    const repo = createFixtureRepo();
    try {
      const head = sh(["git", "-C", repo.path, "rev-parse", "HEAD"], repo.path);
      expect(scanCommitsForWarnings(repo.path, `${head}..HEAD`, HOST_IDENTITY)).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });

  test("a commit matching the identity with no attribution trailer yields no warnings", () => {
    const repo = createFixtureRepo();
    try {
      const base = sh(["git", "-C", repo.path, "rev-parse", "HEAD"], repo.path);
      commitAs(repo.path, HOST_IDENTITY.name, HOST_IDENTITY.email, "feat: clean commit");
      expect(scanCommitsForWarnings(repo.path, `${base}..HEAD`, HOST_IDENTITY)).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });

  test("an author that doesn't match the host identity is flagged by name and email", () => {
    const repo = createFixtureRepo();
    try {
      const base = sh(["git", "-C", repo.path, "rev-parse", "HEAD"], repo.path);
      commitAs(repo.path, "Someone Else", "else@example.com", "feat: not the host identity");
      const warnings = scanCommitsForWarnings(repo.path, `${base}..HEAD`, HOST_IDENTITY);
      expect(warnings.some((w) => w.includes("Someone Else <else@example.com>"))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  test("an attribution trailer is flagged regardless of casing, even with the identity matching", () => {
    const repo = createFixtureRepo();
    try {
      const base = sh(["git", "-C", repo.path, "rev-parse", "HEAD"], repo.path);
      commitAs(
        repo.path,
        HOST_IDENTITY.name,
        HOST_IDENTITY.email,
        "feat: ok\n\nco-authored-by: Someone <someone@example.com>",
      );
      const warnings = scanCommitsForWarnings(repo.path, `${base}..HEAD`, HOST_IDENTITY);
      expect(warnings.some((w) => w.includes("attribution"))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });
});
