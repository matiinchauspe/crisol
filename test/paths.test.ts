import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import path from "node:path";
import { crisolHome } from "../src/paths";

function withCrisolHome(value: string | undefined, fn: () => void): void {
  const original = process.env.CRISOL_HOME;
  if (value === undefined) {
    delete process.env.CRISOL_HOME;
  } else {
    process.env.CRISOL_HOME = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env.CRISOL_HOME;
    } else {
      process.env.CRISOL_HOME = original;
    }
  }
}

describe("crisolHome (theoretical: empty CRISOL_HOME)", () => {
  test("an empty-string CRISOL_HOME is treated as unset, falling back to ~/.crisol", () => {
    withCrisolHome("", () => {
      expect(crisolHome()).toBe(path.join(homedir(), ".crisol"));
    });
  });

  test("an unset CRISOL_HOME falls back to ~/.crisol", () => {
    withCrisolHome(undefined, () => {
      expect(crisolHome()).toBe(path.join(homedir(), ".crisol"));
    });
  });

  test("a relative CRISOL_HOME is resolved to an absolute path", () => {
    withCrisolHome("./some-relative-crisol-home", () => {
      const resolved = crisolHome();
      expect(path.isAbsolute(resolved)).toBe(true);
      expect(resolved).toBe(path.resolve("./some-relative-crisol-home"));
    });
  });

  test("an absolute CRISOL_HOME is kept as-is (modulo normalization)", () => {
    withCrisolHome("/tmp/explicit-crisol-home", () => {
      expect(crisolHome()).toBe(path.resolve("/tmp/explicit-crisol-home"));
    });
  });
});
