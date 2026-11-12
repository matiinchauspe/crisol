import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseGlobalConfig, readGlobalConfig } from "../src/config";
import { resolveCeiling } from "../src/run";
import { createTempHome } from "./support/crisolHome";

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
