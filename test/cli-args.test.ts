import { describe, expect, test } from "bun:test";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { runCli } from "./support/cli";

/**
 * W6: `--base`/`--name` with a missing value, or a value that itself looks
 * like another flag (starts with `--`), must be a usage error with a
 * non-zero exit — never silently treated as "no value given".
 */
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
});
