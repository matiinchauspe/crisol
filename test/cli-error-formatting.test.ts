import { describe, expect, test } from "bun:test";
import { formatError } from "../src/cli";

/**
 * finding 7 (round-2 review): the CLI dropped BOTH causes of an
 * `AggregateError` — printing only its own outer message ("Run failed and
 * Fetch-back also failed") with no indication of what either underlying
 * failure actually was. `formatError` is exported so this can be tested
 * directly; importing `cli.ts` is only safe because of the
 * `import.meta.main` guard around its top-level `main()`/`process.exit`
 * call (otherwise importing it would run the CLI with this test runner's
 * own argv and exit the whole test process).
 */
describe("formatError prints every AggregateError cause (finding 7)", () => {
  test("an AggregateError's message AND both underlying causes are included", () => {
    const aggregate = new AggregateError(
      [new Error("adapter exploded"), new Error("fetch-back failed: no such ref")],
      "Run failed and Fetch-back also failed",
    );
    const formatted = formatError(aggregate);
    expect(formatted).toContain("Run failed and Fetch-back also failed");
    expect(formatted).toContain("adapter exploded");
    expect(formatted).toContain("fetch-back failed: no such ref");
  });

  test("a plain Error still formats as just its own message", () => {
    expect(formatError(new Error("plain failure"))).toBe("plain failure");
  });

  test("a non-Error throwable formats via String()", () => {
    expect(formatError("raw string throw")).toBe("raw string throw");
  });
});
