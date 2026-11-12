import { describe, expect, test } from "bun:test";
import type { ExecResult, Sandbox, StopResult } from "../src/docker";
import { formatGateFeedback, resolveGates, runGates } from "../src/gates";
import { parseGatesArray } from "../src/config";

/**
 * A hand-rolled `Sandbox` double, scripted by exit code — no Docker needed.
 * Same reasoning as `buildDockerRunArgs`'s own pure unit tests: `runGates`'s
 * LOOP logic (run every Gate, collect `{cmd, ok}`, find the first failure)
 * is a pure function of what `exec` returns, so it doesn't need a real
 * container to prove it.
 */
function fakeSandbox(results: Record<string, Partial<ExecResult>>): Sandbox {
  return {
    containerId: "fake",
    mounts: [],
    async exec(cmd: string[]): Promise<ExecResult> {
      const key = cmd.join(" ");
      const scripted = results[key];
      if (!scripted) {
        throw new Error(`fakeSandbox: no scripted result for "${key}"`);
      }
      return { exitCode: 0, stdout: "", stderr: "", ...scripted };
    },
    async stop(): Promise<StopResult> {
      return { ok: true, stderr: "" };
    },
  };
}

describe("parseGatesArray (ticket 02, .crisol/config.toml's gates key)", () => {
  test("parses a single-line double-quoted string array", () => {
    expect(parseGatesArray('gates = ["bun test", "bun run typecheck"]')).toEqual([
      "bun test",
      "bun run typecheck",
    ]);
  });

  test("ignores leading/trailing whitespace and other lines in the file", () => {
    const text = [
      "# a comment",
      "",
      '  gates = ["bun test"]  ',
      'network = ["example.com"]',
    ].join("\n");
    expect(parseGatesArray(text)).toEqual(["bun test"]);
  });

  test("returns [] when there is no gates key at all", () => {
    expect(parseGatesArray('network = ["example.com"]')).toEqual([]);
  });

  test("returns [] for an empty array", () => {
    expect(parseGatesArray("gates = []")).toEqual([]);
  });

  test("unescapes a double quote inside a gate string", () => {
    expect(parseGatesArray('gates = ["echo \\"hi\\""]')).toEqual(['echo "hi"']);
  });
});

describe("resolveGates (ticket 02's Gate ladder: --gate beats repo beats none)", () => {
  test("CLI gates win when present, even with repo gates also declared", () => {
    expect(resolveGates(["cli-gate"], ["repo-gate"])).toEqual(["cli-gate"]);
  });

  test("an empty CLI gate list falls through to the repo's own gates", () => {
    expect(resolveGates([], ["repo-gate"])).toEqual(["repo-gate"]);
  });

  test("undefined CLI gates falls through to the repo's own gates", () => {
    expect(resolveGates(undefined, ["repo-gate"])).toEqual(["repo-gate"]);
  });

  test("neither rung declared anything — none", () => {
    expect(resolveGates(undefined, [])).toEqual([]);
  });
});

describe("runGates (ticket 02)", () => {
  test("every declared Gate runs, even after an earlier one fails", async () => {
    const sandbox = fakeSandbox({
      "bash -c first": { exitCode: 1, stdout: "first failed\n" },
      "bash -c second": { exitCode: 0 },
    });

    const { results, firstFailure } = await runGates(sandbox, ["first", "second"]);

    expect(results).toEqual([
      { cmd: "first", ok: false },
      { cmd: "second", ok: true },
    ]);
    expect(firstFailure).toEqual({ cmd: "first", output: "first failed" });
  });

  test("no failure at all when every Gate is green", async () => {
    const sandbox = fakeSandbox({
      "bash -c a": { exitCode: 0 },
      "bash -c b": { exitCode: 0 },
    });

    const { results, firstFailure } = await runGates(sandbox, ["a", "b"]);

    expect(results).toEqual([
      { cmd: "a", ok: true },
      { cmd: "b", ok: true },
    ]);
    expect(firstFailure).toBeUndefined();
  });

  test("firstFailure is the FIRST red Gate, not a later one", async () => {
    const sandbox = fakeSandbox({
      "bash -c a": { exitCode: 1, stdout: "a broke\n" },
      "bash -c b": { exitCode: 1, stdout: "b also broke\n" },
    });

    const { firstFailure } = await runGates(sandbox, ["a", "b"]);

    expect(firstFailure).toEqual({ cmd: "a", output: "a broke" });
  });

  test("stdout and stderr are both carried into the failure's output", async () => {
    const sandbox = fakeSandbox({
      "bash -c cmd": { exitCode: 1, stdout: "out\n", stderr: "err\n" },
    });

    const { firstFailure } = await runGates(sandbox, ["cmd"]);

    expect(firstFailure?.output).toContain("out");
    expect(firstFailure?.output).toContain("err");
  });
});

describe("formatGateFeedback (ticket 02: the resume message carries the failing command and output)", () => {
  test("the message contains both the cmd and the output", () => {
    const message = formatGateFeedback({ cmd: "bun test", output: "1 test failed" });
    expect(message).toContain("bun test");
    expect(message).toContain("1 test failed");
  });
});
