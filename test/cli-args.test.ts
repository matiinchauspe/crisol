import { describe, expect, test } from "bun:test";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { runCli } from "./support/cli";

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
