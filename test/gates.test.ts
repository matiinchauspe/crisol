import { describe, expect, test } from "bun:test";
import type { ExecResult, Sandbox, StopResult } from "../src/docker";
import { checkCommitted, formatGateFeedback, resolveGates, runGates, snapshotInstallDirt } from "../src/gates";
import type { InstallDirt } from "../src/gates";
import { parseGatesArray } from "../src/config";

/**
 * No Docker needed: `runGates`'s LOOP logic is a pure function of what `exec` returns,
 * so a hand-rolled `Sandbox` double, scripted by exit code, is enough to prove it.
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

describe("checkCommitted: Gates judge only what is committed on the Run's branch", () => {
  const HEAD = "git symbolic-ref --quiet HEAD";
  const STATUS = "git status --porcelain -z";

  test("a clean tree on the branch lets the Gates run", async () => {
    const sandbox = fakeSandbox({
      [HEAD]: { stdout: "refs/heads/crisol/a1b2\n" },
      [STATUS]: { stdout: "" },
    });

    expect(await checkCommitted(sandbox, "crisol/a1b2")).toBeUndefined();
  });

  test("uncommitted changes, untracked files included, are named back to the agent", async () => {
    const sandbox = fakeSandbox({
      [HEAD]: { stdout: "refs/heads/crisol/a1b2\n" },
      [STATUS]: { stdout: " M src/login.ts\0?? src/email.ts\0" },
    });

    const feedback = await checkCommitted(sandbox, "crisol/a1b2");

    expect(feedback).toContain("crisol/a1b2");
    expect(feedback).toContain(" M src/login.ts");
    expect(feedback).toContain("?? src/email.ts");
  });

  test("a staged rename is named with both its paths", async () => {
    // Field order read live from git 2.45.4 in crisol-base:0.2.0.
    const sandbox = fakeSandbox({
      [HEAD]: { stdout: "refs/heads/crisol/a1b2\n" },
      [STATUS]: { stdout: "R  src/new.ts\0src/old.ts\0" },
    });

    expect(await checkCommitted(sandbox, "crisol/a1b2")).toContain("R  src/old.ts -> src/new.ts");
  });

  test("HEAD on another branch is named back, even with a clean tree", async () => {
    const sandbox = fakeSandbox({
      [HEAD]: { stdout: "refs/heads/elsewhere\n" },
      [STATUS]: { stdout: "" },
    });

    const feedback = await checkCommitted(sandbox, "crisol/a1b2");

    expect(feedback).toContain("refs/heads/elsewhere");
    expect(feedback).toContain("refs/heads/crisol/a1b2");
  });

  test("a detached HEAD is named back as detached", async () => {
    const sandbox = fakeSandbox({
      [HEAD]: { exitCode: 1 },
      [STATUS]: { stdout: "" },
    });

    expect(await checkCommitted(sandbox, "crisol/a1b2")).toContain("detached");
  });

  test("a `git status` that fails is never read as a clean tree", async () => {
    const sandbox = fakeSandbox({
      [HEAD]: { stdout: "refs/heads/crisol/a1b2\n" },
      [STATUS]: { exitCode: 128, stderr: "fatal: index file corrupt\n" },
    });

    expect(await checkCommitted(sandbox, "crisol/a1b2")).toContain("index file corrupt");
  });
});

describe("the dependency install's own dirt never blocks the Gates", () => {
  const HEAD = "git symbolic-ref --quiet HEAD";
  const STATUS = "git status --porcelain -z";
  const HASH_LOCKFILE = "git hash-object -- bun.lock";
  // What `bun install` 1.4.4 wrote over an empty bun.lock for one `file:` dependency, and what it
  // left untracked, read live in crisol-base:0.2.0.
  const INSTALLED_LOCKFILE = "217b3d8cf087924bab2220f4d553aa9f81144b54";
  const INSTALL_STATUS = " M bun.lock\0?? node_modules/\0";
  const INSTALL_DIRT: InstallDirt[] = [
    { path: "bun.lock", fingerprint: INSTALLED_LOCKFILE },
    { path: "node_modules/", fingerprint: "-" },
  ];

  test("the snapshot records each path install left dirty, with the content it left there", async () => {
    const sandbox = fakeSandbox({
      [STATUS]: { stdout: INSTALL_STATUS },
      [HASH_LOCKFILE]: { stdout: `${INSTALLED_LOCKFILE}\n` },
    });

    expect(await snapshotInstallDirt(sandbox)).toEqual(INSTALL_DIRT);
  });

  test("a snapshot whose `git status` fails stops the Run instead of excusing nothing or everything", async () => {
    const sandbox = fakeSandbox({ [STATUS]: { exitCode: 128, stderr: "fatal: index file corrupt\n" } });

    await expect(snapshotInstallDirt(sandbox)).rejects.toThrow("index file corrupt");
  });

  test("paths still exactly as install left them let the Gates run", async () => {
    const sandbox = fakeSandbox({
      [HEAD]: { stdout: "refs/heads/crisol/a1b2\n" },
      [STATUS]: { stdout: INSTALL_STATUS },
      [HASH_LOCKFILE]: { stdout: `${INSTALLED_LOCKFILE}\n` },
    });

    expect(await checkCommitted(sandbox, "crisol/a1b2", INSTALL_DIRT)).toBeUndefined();
  });

  test("the agent's own uncommitted change is still named, and install's dirt is not", async () => {
    const sandbox = fakeSandbox({
      [HEAD]: { stdout: "refs/heads/crisol/a1b2\n" },
      [STATUS]: { stdout: ` M src/login.ts\0${INSTALL_STATUS}` },
      [HASH_LOCKFILE]: { stdout: `${INSTALLED_LOCKFILE}\n` },
    });

    const feedback = await checkCommitted(sandbox, "crisol/a1b2", INSTALL_DIRT);

    expect(feedback).toContain(" M src/login.ts");
    expect(feedback).not.toContain("bun.lock");
    expect(feedback).not.toContain("node_modules");
  });

  test("a path install left dirty that the agent changed further is named back", async () => {
    const sandbox = fakeSandbox({
      [HEAD]: { stdout: "refs/heads/crisol/a1b2\n" },
      [STATUS]: { stdout: INSTALL_STATUS },
      [HASH_LOCKFILE]: { stdout: "0123456789abcdef0123456789abcdef01234567\n" },
    });

    const feedback = await checkCommitted(sandbox, "crisol/a1b2", INSTALL_DIRT);

    expect(feedback).toContain(" M bun.lock");
    expect(feedback).not.toContain("node_modules");
  });

  test("install's dirt never excuses HEAD off the branch", async () => {
    const sandbox = fakeSandbox({
      [HEAD]: { stdout: "refs/heads/elsewhere\n" },
      [STATUS]: { stdout: INSTALL_STATUS },
      [HASH_LOCKFILE]: { stdout: `${INSTALLED_LOCKFILE}\n` },
    });

    expect(await checkCommitted(sandbox, "crisol/a1b2", INSTALL_DIRT)).toContain("refs/heads/elsewhere");
  });
});
