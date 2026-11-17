import { describe, expect, test } from "bun:test";
import type { AdapterContext } from "../src/adapter";
import {
  ClaudeCodeAdapter,
  buildAgentLayerDockerfile,
  buildAgentLayerSpec,
  buildLaunchArgs,
  buildResumeArgs,
  parseCliOutput,
  parseClaudeVersionOutput,
} from "../src/adapters/claude-code";
import { CLAUDE_TOKEN_SECRET_NAME } from "../src/secret-store";
import type { ExecResult, Sandbox, StopResult } from "../src/docker";

describe("parseClaudeVersionOutput (ticket 14)", () => {
  test("parses the real host's captured `claude --version` shape", () => {
    // Captured from a real host.
    expect(parseClaudeVersionOutput("2.1.283 (Claude Code)\n")).toBe("2.1.283");
  });

  test("throws, naming the raw output, when no version is found", () => {
    expect(() => parseClaudeVersionOutput("command not found: claude")).toThrow(
      /Could not parse a Claude Code version/,
    );
  });
});

describe("buildAgentLayerDockerfile (ticket 14)", () => {
  test("FROM the given base image, pinned to the given version, attribution off by configuration", () => {
    const dockerfile = buildAgentLayerDockerfile({
      baseImage: "crisol-base:test",
      claudeCodeVersion: "9.9.9",
    });
    expect(dockerfile).toContain("FROM crisol-base:test");
    expect(dockerfile).toContain("bash -s 9.9.9");
    expect(dockerfile).toContain('"commit":""');
    expect(dockerfile).toContain('"pr":""');
    expect(dockerfile).toContain('"sessionUrl":false');
    expect(dockerfile).not.toContain("latest");
    expect(dockerfile).toContain("/home/agent/.claude/settings.json");
  });

  test("the baked settings.json matches Claude Code's own schema types, not just the right keys", () => {
    const dockerfile = buildAgentLayerDockerfile({
      baseImage: "crisol-base:test",
      claudeCodeVersion: "9.9.9",
    });
    const match = /printf '%s' '(.+)' > \/home\/agent\/.claude\/settings\.json/.exec(dockerfile);
    expect(match).not.toBeNull();
    const settings = JSON.parse(match![1]!);
    expect(typeof settings.attribution.commit).toBe("string");
    expect(typeof settings.attribution.pr).toBe("string");
    expect(typeof settings.attribution.sessionUrl).toBe("boolean");
  });

  test("creates a non-root user and switches to it BEFORE installing Claude Code", () => {
    const dockerfile = buildAgentLayerDockerfile({
      baseImage: "crisol-base:test",
      claudeCodeVersion: "9.9.9",
    });
    expect(dockerfile).toContain("adduser");
    expect(dockerfile).toContain("USER agent");
    const userLine = dockerfile.indexOf("USER agent");
    const installLine = dockerfile.indexOf("install.sh");
    expect(userLine).toBeGreaterThan(-1);
    expect(installLine).toBeGreaterThan(userLine);
    expect(dockerfile).not.toContain("USER root");
  });

  test("never installs via npm — the native installer, not @anthropic-ai/claude-code", () => {
    const dockerfile = buildAgentLayerDockerfile({
      baseImage: "crisol-base:test",
      claudeCodeVersion: "9.9.9",
    });
    expect(dockerfile).not.toContain("npm install");
  });

  test("refuses a version that isn't a plain X.Y.Z (argv/shell-injection guard)", () => {
    expect(() =>
      buildAgentLayerDockerfile({ baseImage: "crisol-base:test", claudeCodeVersion: "9.9.9; rm -rf /" }),
    ).toThrow(/is not a plain/);
  });
});

describe("buildAgentLayerSpec (ticket 14)", () => {
  test("tags the image by the Claude Code version, so a version bump gets a new tag", () => {
    const spec = buildAgentLayerSpec({ baseImage: "crisol-base:test", claudeCodeVersion: "1.2.3" });
    expect(spec.tag).toBe("crisol-agent-claude-code:1.2.3");
    expect(spec.dockerfile).toContain("1.2.3");
  });
});

describe("buildLaunchArgs / buildResumeArgs (ticket 14)", () => {
  test("launch runs unattended, as JSON, with no --resume", () => {
    const args = buildLaunchArgs({ binary: "claude" });
    expect(args).toEqual(["claude", "-p", "--dangerously-skip-permissions", "--output-format", "json"]);
  });

  test("launch appends instructions via --append-system-prompt when present", () => {
    const args = buildLaunchArgs({ binary: "claude", instructions: "always use conventional commits" });
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("always use conventional commits");
  });

  test("launch never appends --append-system-prompt when instructions are absent", () => {
    const args = buildLaunchArgs({ binary: "claude" });
    expect(args).not.toContain("--append-system-prompt");
  });

  test("resume carries --resume <sessionId> — the SAME session, never a fresh one", () => {
    const args = buildResumeArgs({ binary: "claude", sessionId: "sess-123" });
    expect(args).toEqual([
      "claude",
      "-p",
      "--resume",
      "sess-123",
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
    ]);
  });
});

describe("parseCliOutput (ticket 14)", () => {
  test("extracts session_id from the real --output-format json shape", () => {
    expect(parseCliOutput(JSON.stringify({ session_id: "abc-123", result: "done" }))).toEqual({
      session_id: "abc-123",
    });
  });

  test("throws on invalid JSON", () => {
    expect(() => parseCliOutput("not json")).toThrow(/not valid JSON/);
  });

  test("throws when session_id is missing", () => {
    expect(() => parseCliOutput(JSON.stringify({ result: "done" }))).toThrow(/no "session_id"/);
  });
});

/** No Docker and no real `claude`, so the real Adapter's argv and session logic run alone. */
function fakeSandbox(responses: string[]): { sandbox: Sandbox; calls: string[][]; stdins: (string | undefined)[] } {
  const calls: string[][] = [];
  const stdins: (string | undefined)[] = [];
  let i = 0;
  const sandbox: Sandbox = {
    containerId: "fake",
    mounts: [],
    async exec(cmd: string[], stdin?: string): Promise<ExecResult> {
      calls.push(cmd);
      stdins.push(stdin);
      const stdout = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return { exitCode: 0, stdout, stderr: "" };
    },
    async stop(): Promise<StopResult> {
      return { ok: true, stderr: "" };
    },
  };
  return { sandbox, calls, stdins };
}

function fakeContext(sandbox: Sandbox, prompt = "fix the bug"): AdapterContext {
  return { sandbox, repoPath: "/clone", prompt };
}

describe("ClaudeCodeAdapter.declarePreStart (ticket 14)", () => {
  test("declares exactly the Claude token by name, no mounts yet, and an ensureImage thunk", () => {
    const adapter = new ClaudeCodeAdapter({ hostVersion: () => "9.9.9" });
    const declaration = adapter.declarePreStart();
    expect(declaration.envNames).toEqual([CLAUDE_TOKEN_SECRET_NAME]);
    expect(declaration.mounts).toEqual([]);
    expect(typeof declaration.ensureImage).toBe("function");
  });

  test("never calls the host `claude --version` when hostVersion is overridden", () => {
    // Shelling out for real would make this depend on the test machine's `claude`.
    expect(() => new ClaudeCodeAdapter({ hostVersion: () => "1.0.0" }).declarePreStart()).not.toThrow();
  });
});

describe("ClaudeCodeAdapter.launch / resumeWithFeedback (ticket 14, fake Sandbox — never the real agent)", () => {
  test("launch execs the binary directly (no shell), hands the prompt over stdin", async () => {
    const { sandbox, calls, stdins } = fakeSandbox([JSON.stringify({ session_id: "sess-aaa", result: "ok" })]);
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    const prompt = `do the thing\n${"x".repeat(200 * 1024)}`;

    await adapter.launch(fakeContext(sandbox, prompt));

    expect(calls).toEqual([["fake-claude", "-p", "--dangerously-skip-permissions", "--output-format", "json"]]);
    expect(stdins).toEqual([prompt]);
  });

  test("resumeWithFeedback reuses the SAME session id launch captured — the ticket's own red Gate", async () => {
    const { sandbox, calls, stdins } = fakeSandbox([
      JSON.stringify({ session_id: "sess-aaa", result: "ok" }),
      JSON.stringify({ session_id: "sess-aaa", result: "fixed" }),
    ]);
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });

    await adapter.launch(fakeContext(sandbox));
    await adapter.resumeWithFeedback(fakeContext(sandbox), "Gate failed: bun test\n\nFAIL");

    expect(calls).toHaveLength(2);
    const resumeArgs = calls[1]!;
    expect(resumeArgs).toContain("--resume");
    expect(resumeArgs[resumeArgs.indexOf("--resume") + 1]).toBe("sess-aaa");
    expect(stdins[1]).toBe("Gate failed: bun test\n\nFAIL");
  });

  test("resumeWithFeedback before launch ever ran throws, rather than silently starting a fresh session", async () => {
    const { sandbox } = fakeSandbox([]);
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    await expect(adapter.resumeWithFeedback(fakeContext(sandbox), "feedback")).rejects.toThrow(
      /before launch ever captured/,
    );
  });

  test("launch throws on a non-zero exit, naming the binary and stderr", async () => {
    const sandbox: Sandbox = {
      containerId: "fake",
      mounts: [],
      async exec(): Promise<ExecResult> {
        return { exitCode: 1, stdout: "", stderr: "auth error" };
      },
      async stop(): Promise<StopResult> {
        return { ok: true, stderr: "" };
      },
    };
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    await expect(adapter.launch(fakeContext(sandbox))).rejects.toThrow(/auth error/);
  });

  test("reportCompletion is synchronous-by-construction: always true, since `-p` already blocked until the turn finished", async () => {
    const { sandbox } = fakeSandbox([JSON.stringify({ session_id: "sess-aaa" })]);
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    await adapter.launch(fakeContext(sandbox));
    expect(await adapter.reportCompletion(fakeContext(sandbox))).toBe(true);
  });
});
