import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import packageJson from "../package.json";
import { createTempHome } from "./support/crisolHome";
import { runCli } from "./support/cli";

describe("crisol --version", () => {
  test("prints the package version and exits 0, outside any git repo and touching nothing", async () => {
    const home = createTempHome();
    try {
      const result = await runCli(["--version"], { cwd: home.path, home: home.path });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${packageJson.version}\n`);
      expect(result.stderr).toBe("");
      expect(readdirSync(home.path)).toHaveLength(0);
    } finally {
      home.cleanup();
    }
  });
});
