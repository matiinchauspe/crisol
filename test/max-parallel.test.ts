import { describe, expect, test } from "bun:test";
import { parseGlobalConfig } from "../src/config";
import { resolveMaxParallel } from "../src/run";

describe("~/.crisol/config's max_parallel", () => {
  test("parses alongside the ceiling keys", () => {
    expect(parseGlobalConfig("max_parallel = 1\nmax_iterations = 2\n", "config")).toEqual({
      maxParallel: 1,
      maxIterations: 2,
    });
  });

  test("rejects zero, naming the source and the key", () => {
    expect(() => parseGlobalConfig("max_parallel = 0", "/home/.crisol/config")).toThrow(
      /\/home\/\.crisol\/config.*max_parallel/,
    );
  });

  test("defaults to 3 when the config leaves it unset", () => {
    expect(resolveMaxParallel({})).toBe(3);
    expect(resolveMaxParallel({ maxParallel: 1 })).toBe(1);
  });
});
