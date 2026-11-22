import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderFailureError, type AdapterContext } from "../src/adapter";
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
import { TENAZA_RELEASE } from "../src/tenaza";
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

describe("buildAgentLayerSpec", () => {
  test("tags the image by a hash of (Project layer image, agent version, Tenaza version), so a version bump gets a new tag", () => {
    const spec = buildAgentLayerSpec({ baseImage: "crisol-base:test", claudeCodeVersion: "1.2.3" });
    expect(spec.tag).toMatch(/^crisol-agent-claude-code:[0-9a-f]{12}$/);
    expect(spec.dockerfile).toContain("1.2.3");
  });

  test("the same inputs reuse the same tag", () => {
    const a = buildAgentLayerSpec({ baseImage: "crisol-base:test", claudeCodeVersion: "1.2.3" });
    const b = buildAgentLayerSpec({ baseImage: "crisol-base:test", claudeCodeVersion: "1.2.3" });
    expect(a.tag).toBe(b.tag);
  });

  test("a changed Project layer image changes the tag, agent version held equal", () => {
    const a = buildAgentLayerSpec({ baseImage: "crisol-base:test", claudeCodeVersion: "1.2.3" });
    const b = buildAgentLayerSpec({ baseImage: "crisol-project:deadbeefcafe", claudeCodeVersion: "1.2.3" });
    expect(a.tag).not.toBe(b.tag);
  });

  test("a changed agent version changes the tag, Project layer image held equal", () => {
    const a = buildAgentLayerSpec({ baseImage: "crisol-base:test", claudeCodeVersion: "1.2.3" });
    const b = buildAgentLayerSpec({ baseImage: "crisol-base:test", claudeCodeVersion: "9.9.9" });
    expect(a.tag).not.toBe(b.tag);
  });

  test("carrying Tenaza changes the tag, Project layer image and agent version held equal", () => {
    const withoutTenaza = buildAgentLayerSpec({ baseImage: "crisol-base:test", claudeCodeVersion: "1.2.3" });
    const withTenaza = buildAgentLayerSpec({
      baseImage: "crisol-base:test",
      claudeCodeVersion: "1.2.3",
      tenaza: TENAZA_RELEASE,
    });
    expect(withoutTenaza.tag).not.toBe(withTenaza.tag);
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
  test("extracts session_id and the agent's last message from the real --output-format json shape", () => {
    expect(parseCliOutput(JSON.stringify({ session_id: "abc-123", result: "done\n\nCRISOL-STOP: parked" }))).toEqual({
      session_id: "abc-123",
      result: "done\n\nCRISOL-STOP: parked",
    });
  });

  test("output without a string result still yields the session, with no last message", () => {
    expect(parseCliOutput(JSON.stringify({ session_id: "abc-123" }))).toEqual({ session_id: "abc-123" });
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

function missingTenazaHome(): string {
  return join(mkdtempSync(join(tmpdir(), "crisol-no-tenaza-")), ".tenaza");
}

function fakeContext(sandbox: Sandbox, prompt = "fix the bug"): AdapterContext {
  return { sandbox, repoPath: "/clone", hostRepoPath: "/host", prompt };
}

describe("ClaudeCodeAdapter.declarePreStart", () => {
  test("declares exactly the Claude token by name, no mounts without Tenaza, and an ensureImage thunk", () => {
    const adapter = new ClaudeCodeAdapter({ hostVersion: () => "9.9.9", tenazaHome: missingTenazaHome() });
    const declaration = adapter.declarePreStart("crisol-base:test");
    expect(declaration.envNames).toEqual([CLAUDE_TOKEN_SECRET_NAME]);
    expect(declaration.mounts).toEqual([]);
    expect(typeof declaration.ensureImage).toBe("function");
  });

  test("never calls the host `claude --version` when hostVersion is overridden", () => {
    // Shelling out for real would make this depend on the test machine's `claude`.
    expect(() =>
      new ClaudeCodeAdapter({ hostVersion: () => "1.0.0", tenazaHome: missingTenazaHome() }).declarePreStart("crisol-base:test"),
    ).not.toThrow();
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

  test("launch and resumeWithFeedback each resolve with that turn's `result`, verbatim (ticket 20)", async () => {
    const { sandbox } = fakeSandbox([
      JSON.stringify({ session_id: "sess-aaa", result: "first turn" }),
      JSON.stringify({ session_id: "sess-aaa", result: "  second turn\n" }),
    ]);
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });

    expect(await adapter.launch(fakeContext(sandbox))).toBe("first turn");
    expect(await adapter.resumeWithFeedback(fakeContext(sandbox), "feedback")).toBe("  second turn\n");
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

function readCapture(dir: string, prefix: string): ExecResult {
  const exit = /^exit=(\d+)$/.exec(readFileSync(join(dir, `${prefix}.exit.txt`), "utf8").trim());
  return {
    exitCode: Number(exit![1]),
    stdout: readFileSync(join(dir, `${prefix}.stdout.json`), "utf8"),
    stderr: readFileSync(join(dir, `${prefix}.stderr.txt`), "utf8"),
  };
}

const AUTH_CAPTURE_DIR = join(import.meta.dir, "fixtures", "claude-auth-failure");
const AUTH_OAUTH_CAPTURE_DIR = join(import.meta.dir, "fixtures", "claude-auth-failure-oauth");
const QUOTA_FIXTURE_DIR = join(import.meta.dir, "fixtures", "claude-quota-failure");
const RATE_LIMIT_FIXTURE_DIR = join(import.meta.dir, "fixtures", "claude-rate-limit-failure");

function readAuthCapture(): ExecResult {
  return readCapture(AUTH_CAPTURE_DIR, "auth");
}

function readOAuthCapture(): ExecResult {
  return readCapture(AUTH_OAUTH_CAPTURE_DIR, "oauth-invalid");
}

function readQuotaFixture(): ExecResult {
  return readCapture(QUOTA_FIXTURE_DIR, "quota");
}

function readRateLimitFixture(): ExecResult {
  return readCapture(RATE_LIMIT_FIXTURE_DIR, "rate-limit");
}

function sandboxAnswering(result: ExecResult): Sandbox {
  return {
    containerId: "fake",
    mounts: [],
    async exec(): Promise<ExecResult> {
      return result;
    },
    async stop(): Promise<StopResult> {
      return { ok: true, stderr: "" };
    },
  };
}

async function rejectionOf(turn: Promise<unknown>): Promise<unknown> {
  try {
    await turn;
  } catch (error) {
    return error;
  }
  throw new Error("expected the turn to reject");
}

describe("ClaudeCodeAdapter classifies a provider failure (ticket 19, real captured output)", () => {
  test("the captured failed authentication makes launch throw ProviderFailureError with category auth", async () => {
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    const error = await rejectionOf(adapter.launch(fakeContext(sandboxAnswering(readAuthCapture()))));
    expect(error).toBeInstanceOf(ProviderFailureError);
    expect((error as ProviderFailureError).category).toBe("auth");
    expect((error as ProviderFailureError).message).toContain("Invalid API key");
  });

  test("the captured failed authentication on a resumed turn throws ProviderFailureError too", async () => {
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    const error = await rejectionOf(
      adapter.continueSession(fakeContext(sandboxAnswering(readAuthCapture())), "sess-kept", "go on"),
    );
    expect(error).toBeInstanceOf(ProviderFailureError);
    expect((error as ProviderFailureError).category).toBe("auth");
  });

  test("the captured invalid CLAUDE_CODE_OAUTH_TOKEN makes launch throw ProviderFailureError with category auth too (ticket 22's amendment)", async () => {
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    const error = await rejectionOf(adapter.launch(fakeContext(sandboxAnswering(readOAuthCapture()))));
    expect(error).toBeInstanceOf(ProviderFailureError);
    expect((error as ProviderFailureError).category).toBe("auth");
    expect((error as ProviderFailureError).message).toContain("OAuth access token is invalid");
  });

  test("an API error with another status stays a plain error, never a provider failure", async () => {
    const capture = readAuthCapture();
    const stdout = JSON.stringify({ ...JSON.parse(capture.stdout), api_error_status: 500 });
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    const error = await rejectionOf(adapter.launch(fakeContext(sandboxAnswering({ ...capture, stdout }))));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProviderFailureError);
    expect((error as Error).message).toContain("fake-claude exited 1");
  });

  test("the result text alone never classifies: Invalid API key without the structured fields stays a plain error", async () => {
    const stdout = JSON.stringify({ session_id: "sess-aaa", is_error: true, result: "Invalid API key · Fix external API key" });
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    const error = await rejectionOf(adapter.launch(fakeContext(sandboxAnswering({ exitCode: 1, stdout, stderr: "" }))));
    expect(error).not.toBeInstanceOf(ProviderFailureError);
  });
});

describe("ClaudeCodeAdapter classifies rate limit and exhausted quota (ticket 22, cited real reports, never a capture)", () => {
  test("the exhausted-quota fixture makes launch throw ProviderFailureError with category quota", async () => {
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    const error = await rejectionOf(adapter.launch(fakeContext(sandboxAnswering(readQuotaFixture()))));
    expect(error).toBeInstanceOf(ProviderFailureError);
    expect((error as ProviderFailureError).category).toBe("quota");
    expect((error as ProviderFailureError).message).toContain("You're out of extra usage");
  });

  test("the rate-limit fixture makes launch throw ProviderFailureError with category 'rate limit'", async () => {
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    const error = await rejectionOf(adapter.launch(fakeContext(sandboxAnswering(readRateLimitFixture()))));
    expect(error).toBeInstanceOf(ProviderFailureError);
    expect((error as ProviderFailureError).category).toBe("rate limit");
    expect((error as ProviderFailureError).message).toContain("temporarily limiting requests");
  });

  test("a 429 whose result carries no known quota phrase is a rate limit even with no result text at all", async () => {
    const stdout = JSON.stringify({ is_error: true, terminal_reason: "api_error", api_error_status: 429 });
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    const error = await rejectionOf(adapter.launch(fakeContext(sandboxAnswering({ exitCode: 1, stdout, stderr: "" }))));
    expect(error).toBeInstanceOf(ProviderFailureError);
    expect((error as ProviderFailureError).category).toBe("rate limit");
  });

  test("a quota phrase at a status other than 401/429 is neither quota nor rate limit: it stays a plain error", async () => {
    const stdout = JSON.stringify({ is_error: true, terminal_reason: "api_error", api_error_status: 500, result: "You're out of extra usage" });
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    const error = await rejectionOf(adapter.launch(fakeContext(sandboxAnswering({ exitCode: 1, stdout, stderr: "" }))));
    expect(error).not.toBeInstanceOf(ProviderFailureError);
  });

  test("an exhausted API-key credit balance classifies as quota too, with no captured envelope to read it from", async () => {
    const stdout = JSON.stringify({
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 400,
      result: "Your credit balance is too low to access the Claude API.",
    });
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });
    const error = await rejectionOf(adapter.launch(fakeContext(sandboxAnswering({ exitCode: 1, stdout, stderr: "" }))));
    expect(error).toBeInstanceOf(ProviderFailureError);
    expect((error as ProviderFailureError).category).toBe("quota");
  });

  test("ticket 30: a 401 whose result carries a quota phrase, or 'credit balance is too low', stays auth", async () => {
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });

    const withQuotaPhrase = JSON.stringify({
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 401,
      result: "You're out of extra usage · resets 6:40pm",
    });
    const quotaPhraseError = await rejectionOf(
      adapter.launch(fakeContext(sandboxAnswering({ exitCode: 1, stdout: withQuotaPhrase, stderr: "" }))),
    );
    expect(quotaPhraseError).toBeInstanceOf(ProviderFailureError);
    expect((quotaPhraseError as ProviderFailureError).category).toBe("auth");

    const withCreditTooLow = JSON.stringify({
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 401,
      result: "Your credit balance is too low to access the Claude API.",
    });
    const creditTooLowError = await rejectionOf(
      adapter.launch(fakeContext(sandboxAnswering({ exitCode: 1, stdout: withCreditTooLow, stderr: "" }))),
    );
    expect(creditTooLowError).toBeInstanceOf(ProviderFailureError);
    expect((creditTooLowError as ProviderFailureError).category).toBe("auth");
  });
});

describe("ClaudeCodeAdapter.continueSession (ticket 21, fake Sandbox — never the real agent)", () => {
  test("a fresh Adapter resumes the session it is handed with the request over stdin, then keeps resuming it on a red Gate", async () => {
    const { sandbox, calls, stdins } = fakeSandbox([
      JSON.stringify({ session_id: "sess-kept", result: "review applied" }),
      JSON.stringify({ session_id: "sess-kept", result: "fixed" }),
    ]);
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9" });

    expect(await adapter.continueSession(fakeContext(sandbox), "sess-kept", "rename it, please")).toBe("review applied");
    await adapter.resumeWithFeedback(fakeContext(sandbox), "Gate failed: bun test");

    expect(calls).toEqual([
      ["fake-claude", "-p", "--resume", "sess-kept", "--dangerously-skip-permissions", "--output-format", "json"],
      ["fake-claude", "-p", "--resume", "sess-kept", "--dangerously-skip-permissions", "--output-format", "json"],
    ]);
    expect(stdins).toEqual(["rename it, please", "Gate failed: bun test"]);
    expect(adapter.sessionId()).toBe("sess-kept");
  });
});
