import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SCRIPT, FakeAdapter } from "../src/adapters/fake";
import { parseGlobalConfig, readGlobalConfig } from "../src/config";
import { slotPath } from "../src/paths";
import { resolveCeiling, run } from "../src/run";
import type { RunOptions } from "../src/run";
import { DarwinFlockSlotLock } from "../src/slots";
import { createTempHome } from "./support/crisolHome";
import { HANGING_INSTALL, commitFiles, createFixtureRepo } from "./support/fixtureRepo";
import { onlyRunId, readLog, readResult, removeRunContainers, runContainers } from "./support/runState";

describe("parseGlobalConfig (~/.crisol/config's max_iterations / timeout_minutes)", () => {
  test("parses both keys", () => {
    expect(parseGlobalConfig("max_iterations = 2\ntimeout_minutes = 10\n", "config")).toEqual({
      maxIterations: 2,
      timeoutMinutes: 10,
    });
  });

  test("ignores an unknown key alongside a known one", () => {
    expect(parseGlobalConfig("network_mode = 3\nmax_iterations = 2\n", "config")).toEqual({
      maxIterations: 2,
    });
  });

  test("returns {} when neither key is present at all", () => {
    expect(parseGlobalConfig("network_mode = 3\n", "config")).toEqual({});
  });

  test("rejects a non-integer value, naming the source and the key", () => {
    expect(() => parseGlobalConfig('max_iterations = "two"', "/home/.crisol/config")).toThrow(
      /\/home\/\.crisol\/config/,
    );
    expect(() => parseGlobalConfig('max_iterations = "two"', "/home/.crisol/config")).toThrow(
      /max_iterations/,
    );
  });

  test("rejects zero", () => {
    expect(() => parseGlobalConfig("max_iterations = 0", "config")).toThrow(/max_iterations/);
  });

  test("rejects a negative value", () => {
    expect(() => parseGlobalConfig("timeout_minutes = -5", "config")).toThrow(/timeout_minutes/);
  });
});

describe("readGlobalConfig", () => {
  test("a missing file falls through to {} — no override at all", () => {
    const home = createTempHome();
    try {
      expect(readGlobalConfig(home.path)).toEqual({});
    } finally {
      home.cleanup();
    }
  });

  test("reads both keys from ~/.crisol/config on disk", () => {
    const home = createTempHome();
    try {
      writeFileSync(path.join(home.path, "config"), "max_iterations = 4\ntimeout_minutes = 30\n");
      expect(readGlobalConfig(home.path)).toEqual({ maxIterations: 4, timeoutMinutes: 30 });
    } finally {
      home.cleanup();
    }
  });

  test("an invalid value in the file on disk still names the real file path", () => {
    const home = createTempHome();
    try {
      writeFileSync(path.join(home.path, "config"), "max_iterations = nope\n");
      expect(() => readGlobalConfig(home.path)).toThrow(path.join(home.path, "config"));
    } finally {
      home.cleanup();
    }
  });
});

describe("resolveCeiling (a per-Run value beats ~/.crisol/config beats the built-in default, per knob)", () => {
  const defaults = { maxIterations: 5, ceilingMs: 60 * 60 * 1000 };

  test("falls all the way through to the built-in default when nothing else is set", () => {
    expect(resolveCeiling({}, {}, defaults)).toEqual(defaults);
  });

  test("the global config wins over the default", () => {
    expect(resolveCeiling({}, { maxIterations: 2, timeoutMinutes: 10 }, defaults)).toEqual({
      maxIterations: 2,
      ceilingMs: 10 * 60 * 1000,
    });
  });

  test("a per-Run override wins over the global config", () => {
    expect(
      resolveCeiling({ maxIterations: 7, ceilingMs: 90_000 }, { maxIterations: 2, timeoutMinutes: 10 }, defaults),
    ).toEqual({ maxIterations: 7, ceilingMs: 90_000 });
  });

  test("each knob resolves independently — one from the per-Run override, the other from the config", () => {
    expect(
      resolveCeiling({ ceilingMs: 5_000 }, { maxIterations: 2, timeoutMinutes: 10 }, defaults),
    ).toEqual({ maxIterations: 2, ceilingMs: 5_000 });
  });

  test("a config timeout_minutes with no per-Run ceilingMs converts minutes to ms", () => {
    expect(resolveCeiling({}, { timeoutMinutes: 1 }, defaults)).toEqual({
      maxIterations: defaults.maxIterations,
      ceilingMs: 60_000,
    });
  });
});

/** The Sandbox's own keep-alive (`startSandbox`): a process that, by design, never exits. */
const NEVER_EXITS = "tail -f /dev/null";
const BUDGET_MS = 3_000;

describe("the wall-clock ceiling ends a Run whatever it is doing", () => {
  async function runUntilCeiling(options: Pick<RunOptions, "adapter" | "gates">): Promise<void> {
    const home = createTempHome();
    const repo = createFixtureRepo();
    let id: string | undefined;
    try {
      const startedAt = Date.now();
      const result = await run({
        task: "hang",
        cwd: repo.path,
        home: home.path,
        ...options,
        maxIterations: 1000,
        ceilingMs: BUDGET_MS,
      });
      const elapsedMs = Date.now() - startedAt;
      id = onlyRunId(home.path);

      expect(result).toMatchObject({ status: "not-converged", reason: "ceiling", fetchBack: true });
      expect(readResult(id, home.path)).toMatchObject({ status: "not-converged", reason: "ceiling" });
      expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS);
      // Sandbox start, teardown and Fetch-back on top of the budget, never another budget's worth of waiting.
      expect(elapsedMs).toBeLessThan(BUDGET_MS + 30_000);
      expect(readLog(id, home.path)).toContain(`ceiling reached: ${BUDGET_MS}ms`);
      expect(runContainers(id)).toEqual([]);
      const slot = new DarwinFlockSlotLock().tryLock(slotPath(1, home.path));
      expect(slot).toBeDefined();
      slot?.release();
    } finally {
      if (id !== undefined) removeRunContainers(id);
      home.cleanup();
      repo.cleanup();
    }
  }

  test(
    "a first turn that never returns, in a Run with no Gates, ends at the budget",
    () => runUntilCeiling({ adapter: new FakeAdapter([NEVER_EXITS]), gates: [] }),
    60_000,
  );

  test(
    "a Gate that never exits ends at the budget",
    () => runUntilCeiling({ adapter: new FakeAdapter(DEFAULT_SCRIPT), gates: [NEVER_EXITS] }),
    60_000,
  );
});

describe("the wall-clock ceiling covers the steps before the first turn", () => {
  // Long enough for the wall and the Sandbox to come up first, so the budget runs out mid-install.
  const INSTALL_BUDGET_MS = 10_000;

  test(
    "a dependency install that never returns ends at the budget, before any turn",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      commitFiles(repo.path, HANGING_INSTALL, "chore: add a package whose install hangs");
      let id: string | undefined;
      try {
        const startedAt = Date.now();
        const result = await run({
          task: "hang in install",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(DEFAULT_SCRIPT),
          ceilingMs: INSTALL_BUDGET_MS,
        });
        const elapsedMs = Date.now() - startedAt;
        id = onlyRunId(home.path);

        expect(result).toMatchObject({ status: "not-converged", reason: "ceiling", iterations: 0, fetchBack: true });
        expect(elapsedMs).toBeLessThan(INSTALL_BUDGET_MS + 30_000);
        const log = readLog(id, home.path);
        expect(log).toContain("installing dependencies with bun");
        expect(log).not.toContain("dependencies installed");
        expect(log).toContain(`ceiling reached: ${INSTALL_BUDGET_MS}ms`);
        expect(runContainers(id)).toEqual([]);
      } finally {
        if (id !== undefined) removeRunContainers(id);
        home.cleanup();
        repo.cleanup();
      }
    },
    90_000,
  );
});
