import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { currentPlatform, UNSUPPORTED_PLATFORM_MESSAGE } from "../src/platform";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { runCli } from "./support/cli";

describe("non-macOS platform (ticket 01)", () => {
  test("crisol exits at once with the platform message, before touching Docker, git, or CRISOL_HOME", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const result = await runCli(["run", "do nothing", "--json"], {
        cwd: repo.path,
        home: home.path,
        env: { CRISOL_PLATFORM: "linux" },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(UNSUPPORTED_PLATFORM_MESSAGE);
      expect(result.stdout).toBe("");
      // The platform check runs before any side effect — nothing was ever
      // created under CRISOL_HOME, not even the `runs/` directory.
      expect(readdirSync(home.path)).toHaveLength(0);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("CRISOL_PLATFORM can only force a failure (theoretical)", () => {
  test("CRISOL_PLATFORM=darwin never overrides the REAL platform — it cannot fake support", () => {
    const originalPlatform = process.platform;
    const originalEnv = process.env.CRISOL_PLATFORM;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.CRISOL_PLATFORM = "darwin";
    try {
      // A "darwin" override is ignored: only a NON-darwin override is ever
      // honoured (to simulate an unsupported host in tests), so the real,
      // unsupported platform still decides.
      expect(currentPlatform()).toBe("linux");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      if (originalEnv === undefined) {
        delete process.env.CRISOL_PLATFORM;
      } else {
        process.env.CRISOL_PLATFORM = originalEnv;
      }
    }
  });

  test("a non-darwin CRISOL_PLATFORM override is still honoured (the test seam itself)", () => {
    const originalEnv = process.env.CRISOL_PLATFORM;
    process.env.CRISOL_PLATFORM = "linux";
    try {
      expect(currentPlatform()).toBe("linux");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CRISOL_PLATFORM;
      } else {
        process.env.CRISOL_PLATFORM = originalEnv;
      }
    }
  });

  test("an empty-string CRISOL_PLATFORM is treated as unset (extra: mirrors crisolHome's own rule)", () => {
    const originalEnv = process.env.CRISOL_PLATFORM;
    process.env.CRISOL_PLATFORM = "";
    try {
      expect(currentPlatform()).toBe(process.platform);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CRISOL_PLATFORM;
      } else {
        process.env.CRISOL_PLATFORM = originalEnv;
      }
    }
  });
});
