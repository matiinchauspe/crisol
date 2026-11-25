import { describe, expect, test } from "bun:test";
import { BUILT_IN_ALLOWLIST } from "../src/network";
import type { RunResult } from "../src/run";
import { colourIsOn, formatRunResult } from "../src/run-result-output";
import { stopLine } from "../src/stop-line";

const ANSI = /\x1b\[/;

const FINAL_MESSAGE =
  'The pid tests now run everywhere. `bun run test` gives 1278 pass and says "done".\n\n' +
  "**The seam:** `handleClaudeHook` takes an optional `platform` argument, and this sentence is long enough to need wrapping.\n\n" +
  "- one bullet\n- another bullet";

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    run: "d425a1b7",
    branch: "crisol/linux-tests",
    base: "main",
    status: "verified",
    iterations: 1,
    gates: [
      { cmd: "bun run typecheck", ok: true },
      { cmd: "bun run test", ok: true },
    ],
    network: "allowlist",
    blocked: [],
    warnings: [],
    fetchBack: true,
    finishedAt: 0,
    finalMessage: FINAL_MESSAGE,
    ...overrides,
  };
}

const plain = { colour: false, columns: 80, allowlist: BUILT_IN_ALLOWLIST, awaitsRecover: false };
const coloured = { ...plain, colour: true };

describe("formatRunResult", () => {
  test("a verified Run shows its status, iterations, branch, base and every Gate with its mark", () => {
    const block = formatRunResult(result(), plain);
    const [header, branchLine] = block.split("\n");
    expect(header).toBe("Run d425a1b7  verified  ·  1 iteration");
    expect(branchLine).toBe("  branch crisol/linux-tests   (base main)");
    expect(block).toContain("Gates\n  ✓ bun run typecheck\n  ✓ bun run test");
  });

  test("without colour the Final message is verbatim Markdown, no escapes and no ANSI", () => {
    const block = formatRunResult(result(), plain);
    expect(block).toContain(`Final message\n${FINAL_MESSAGE}`);
    expect(block).not.toContain("\\n");
    expect(block).not.toContain('\\"');
    expect(block).not.toMatch(ANSI);
  });

  test("with colour the Final message is rendered and wrapped to the width", () => {
    const block = formatRunResult(result(), { ...coloured, columns: 60 });
    const message = block.slice(block.indexOf("Final message"));
    expect(message).toMatch(ANSI);
    expect(message).not.toContain("**The seam:**");
    const visibleWidths = message.split("\n").map((line) => Bun.stringWidth(line));
    expect(Math.max(...visibleWidths)).toBeLessThanOrEqual(60);
  });

  test("the status is colour-coded: verified green, not-converged red, the rest yellow", () => {
    expect(formatRunResult(result(), coloured)).toContain("\x1b[32mverified");
    expect(formatRunResult(result({ status: "not-converged", reason: "ceiling" }), coloured)).toContain(
      "\x1b[31mnot-converged",
    );
    for (const status of ["unverified", "parked", "checkpoint"] as const) {
      expect(formatRunResult(result({ status }), coloured)).toContain(`\x1b[33m${status}`);
    }
  });

  test("a not-converged Run shows its reason beside the status and marks the failing Gate", () => {
    const block = formatRunResult(
      result({
        status: "not-converged",
        reason: "ceiling",
        iterations: 5,
        gates: [
          { cmd: "bun run typecheck", ok: true },
          { cmd: "bun run test", ok: false },
        ],
      }),
      plain,
    );
    expect(block.split("\n")[0]).toBe("Run d425a1b7  not-converged — ceiling  ·  5 iterations");
    expect(block).toContain("  ✓ bun run typecheck\n  ✗ bun run test");
  });

  test("blocked and warnings print only when non-empty, blocked with its `crisol allow` lines", () => {
    const quiet = formatRunResult(result(), plain);
    expect(quiet).not.toContain("Blocked");
    expect(quiet).not.toContain("Warnings");

    const noisy = formatRunResult(
      result({
        blocked: [{ host: "http-intake.logs.us5.datadoghq.com", count: 1 }],
        warnings: ["first warning", "second warning"],
      }),
      plain,
    );
    expect(noisy).toContain(
      "Blocked\n  http-intake.logs.us5.datadoghq.com (1 attempt). Allow it for every repo, or for this repo only, with:\n" +
        "    crisol allow http-intake.logs.us5.datadoghq.com\n" +
        "    crisol allow http-intake.logs.us5.datadoghq.com --repo",
    );
    expect(noisy).toContain("Warnings\n  first warning\n  second warning");
  });

  test("a Final message ending in a Stop line prints without it", () => {
    for (const colour of [false, true]) {
      const block = formatRunResult(
        result({ status: "parked", finalMessage: `Which seam do you want?\n\n${stopLine("parked")}\n` }),
        { ...plain, colour },
      );
      expect(block).toContain("Which seam do you want?");
      expect(block).not.toContain("CRISOL-STOP");
    }
  });

  test("a Stop line quoted mid-message is the agent's text and stays", () => {
    const finalMessage = `I would end with ${stopLine("parked")} if I stopped.\n\nBut I did not.`;
    expect(formatRunResult(result({ finalMessage }), plain)).toContain(stopLine("parked"));
  });

  test("a Run whose branch awaits `crisol recover` says so", () => {
    const block = formatRunResult(result({ fetchBack: false }), { ...plain, awaitsRecover: true });
    expect(block).toContain("Not fetched back: `crisol recover` brings the branch in.");
    expect(formatRunResult(result(), plain)).not.toContain("Not fetched back");
  });

  test("a Final message that is only a Stop line prints no Final message section", () => {
    for (const colour of [false, true]) {
      const block = formatRunResult(result({ status: "checkpoint", finalMessage: stopLine("checkpoint") }), {
        ...plain,
        colour,
      });
      expect(block).not.toContain("Final message");
    }
  });

  test("control bytes the agent wrote never reach the terminal, in either mode", () => {
    const hostile = result({
      finalMessage: "Done.\x1b]0;owned\x07 Then\x1b[2J cleared.\x1b[8mhidden\x9b\r\n\tindented",
      warnings: ["author \x1b[8mhidden\x1b[2J name"],
      reason: "error: bad\x1b[2J",
      status: "not-converged",
    });
    const plainBlock = formatRunResult(hostile, plain);
    expect(plainBlock).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(plainBlock).toContain("Done.]0;owned Then[2J cleared.[8mhidden\n\tindented");
    // With colour, Crisol's own styling is the only escape left: the agent's `[8m` hide never survives.
    const colourBlock = formatRunResult(hostile, coloured);
    expect(colourBlock).not.toContain("\x1b[8m");
    expect(colourBlock).not.toContain("\x1b[2J");
    expect(colourBlock).not.toContain("\x1b]");
  });

  test("a Run with no Gates and no Final message prints neither section", () => {
    const block = formatRunResult(result({ gates: [], finalMessage: undefined }), plain);
    expect(block).not.toContain("Gates");
    expect(block).not.toContain("Final message");
  });
});

describe("colourIsOn", () => {
  test("only a TTY with NO_COLOR unset or empty gets colour", () => {
    expect(colourIsOn(true, {})).toBe(true);
    expect(colourIsOn(true, { NO_COLOR: "" })).toBe(true);
    expect(colourIsOn(true, { NO_COLOR: "1" })).toBe(false);
    expect(colourIsOn(false, {})).toBe(false);
    expect(colourIsOn(undefined, {})).toBe(false);
  });
});
