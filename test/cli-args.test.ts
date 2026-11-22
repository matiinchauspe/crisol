import { describe, expect, test } from "bun:test";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { runCli } from "./support/cli";
import { runIds } from "./support/runState";

/** A missing value, or one that looks like another flag, must be a usage error — never silently treated as "no value given". */
describe("crisol run argument validation (W6)", () => {
  test("--base with no value at all is a usage error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--base"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--base");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--base followed by another flag is a usage error, not an empty base", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--base", "--json"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--base");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--name with no value at all is a usage error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--name"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--name");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--name followed by another flag is a usage error, never treated as the branch name", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--name", "--json"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--name");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--gate with no value at all is a usage error (ticket 02)", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--gate"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--gate");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--gate followed by another flag is a usage error, never treated as the Gate command (ticket 02)", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--gate", "--json"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--gate");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("crisol run --max-iterations / --timeout validation", () => {
  test("--max-iterations with no value at all is a usage error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--max-iterations"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--max-iterations");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--max-iterations followed by another flag is a usage error, never treated as its value", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--max-iterations", "--json"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--max-iterations");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--max-iterations with a non-integer value is a usage error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--max-iterations", "soon"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--max-iterations");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--max-iterations 0 is a usage error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--max-iterations", "0"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--max-iterations");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--max-iterations -3 is a usage error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--max-iterations", "-3"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--max-iterations");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--timeout with no value at all is a usage error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--timeout"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--timeout");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--timeout followed by another flag is a usage error, never treated as its value", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--timeout", "--json"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--timeout");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--timeout with a non-integer value is a usage error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--timeout", "forever"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--timeout");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--timeout 0 is a usage error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--timeout", "0"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--timeout");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

/**
 * `--adapter`'s own validation (ticket 14) — checked ONLY through the usage-error paths,
 * which fail during argument parsing, BEFORE `run()` is ever called. `--adapter claude-code`
 * itself is never exercised here: that would reach the real `ClaudeCodeAdapter` and, through
 * it, the real `claude --version` and a real Docker image build — exactly what the automated
 * suite must never do. See `test/claude-code-adapter.test.ts` for the real Adapter's own tests.
 */
describe("crisol run --adapter validation (ticket 14)", () => {
  test("--adapter with no value at all is a usage error", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--adapter"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--adapter");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--adapter with an unrecognised name is a usage error, never silently falling back to fake", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--adapter", "pi"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--adapter");
      expect(result.stderr).toContain("pi");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("--adapter fake (explicit default) behaves exactly like omitting it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "say hello", "--adapter", "fake", "--json"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "unverified" });
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("crisol run --continue refuses an Adapter mismatch at the CLI (ticket 30)", () => {
  test("exit 1, stderr names both Adapters, and the mismatched attempt starts no Run of its own", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const first = await runCli(["run", "say hello", "--name", "cli-mismatch", "--json"], {
        cwd: repo.path,
        home: home.path,
      });
      expect(first.exitCode).toBe(0);
      const firstResult = JSON.parse(first.stdout);
      expect(firstResult.adapter).toBe("fake");

      const mismatched = await runCli(
        ["run", "say more", "--continue", "cli-mismatch", "--adapter", "claude-code", "--json"],
        { cwd: repo.path, home: home.path },
      );

      expect(mismatched.exitCode).toBe(1);
      expect(mismatched.stderr).toMatch(/Adapter "fake", not "claude-code"/);
      expect(runIds(home.path)).toEqual([firstResult.run]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

/**
 * `crisol auth`'s own argument validation, checked here through the real CLI process,
 * ONLY for the usage-error case: it must run before `runAuth` is ever called, so this
 * never reaches the real `claude setup-token`. The real `auth` flow is exercised with
 * fakes in `test/auth.test.ts` instead.
 */
describe("crisol auth argument validation (ticket 08)", () => {
  test("an unexpected argument is a usage error, never reaching the real obtainer", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["auth", "extra-arg"], { cwd: repo.path, home: home.path });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Unexpected argument");
      expect(result.stderr).toContain("crisol auth");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});
