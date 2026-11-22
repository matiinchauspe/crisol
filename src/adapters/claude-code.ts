import { ProviderFailureError, type Adapter, type AdapterContext, type PreStartDeclaration } from "../adapter";
import { contentHash, ensureImageFromDockerfile, type ExecResult } from "../docker";
import { CLAUDE_TOKEN_SECRET_NAME } from "../secret-store";

const VERSION_PATTERN = /^(\d+\.\d+\.\d+)/;
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

/** `claude --version` prints e.g. `2.1.283 (Claude Code)`; only the leading `X.Y.Z` is the version. */
export function parseClaudeVersionOutput(raw: string): string {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (!match || match[1] === undefined) {
    throw new Error(`Could not parse a Claude Code version from \`claude --version\` output: "${raw.trim()}".`);
  }
  return match[1];
}

function hostClaudeVersion(): string {
  const proc = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`\`claude --version\` failed: ${proc.stderr.toString("utf8").trim()}`);
  }
  return parseClaudeVersionOutput(proc.stdout.toString("utf8"));
}

/**
 * Attribution is off by configuration, never by asking the model. `attribution.commit`/`.pr`
 * take the trailer string (empty hides it), not a boolean: `claude doctor` rejects a boolean.
 * `USE_BUILTIN_RIPGREP: "0"` because the bundled ripgrep targets glibc and the image is musl.
 */
const AGENT_SETTINGS = {
  attribution: { commit: "", pr: "", sessionUrl: false },
  env: { USE_BUILTIN_RIPGREP: "0" },
};

/** A real account, not a bare numeric `-u`, so `$HOME` resolves for every tool, Claude Code included. */
const AGENT_USER = "agent";
const AGENT_UID = 1000;
const AGENT_HOME = "/home/agent";

export interface AgentLayerSpec {
  tag: string;
  dockerfile: string;
}

/**
 * Pinned to the host's exact Claude Code version, so a Gate never passes or fails on version
 * drift. Non-root, because Claude Code refuses `--dangerously-skip-permissions` as root. No
 * `COPY`: the image is built from stdin, with no build context.
 */
export function buildAgentLayerDockerfile(options: { baseImage: string; claudeCodeVersion: string }): string {
  const { baseImage, claudeCodeVersion } = options;
  if (!PLAIN_VERSION.test(claudeCodeVersion)) {
    throw new Error(
      `"${claudeCodeVersion}" is not a plain "X.Y.Z" version; refusing to embed it in a Dockerfile RUN step.`,
    );
  }
  // No single quotes in this JSON, so the whole blob is safe inside a single-quoted shell argument.
  const settingsJson = JSON.stringify(AGENT_SETTINGS);
  return [
    `FROM ${baseImage}`,
    // What Claude Code's docs require on Alpine/musl; ripgrep because the bundled one targets glibc.
    "RUN apk add --no-cache curl libgcc libstdc++ ripgrep",
    // `-D`: without it BusyBox prompts for a password, and the build has no stdin to answer it.
    `RUN adduser -D -h ${AGENT_HOME} -s /bin/bash -u ${AGENT_UID} ${AGENT_USER}`,
    `USER ${AGENT_USER}`,
    `ENV HOME="${AGENT_HOME}"`,
    `RUN curl -fsSL https://claude.ai/install.sh | bash -s ${claudeCodeVersion}`,
    `ENV PATH="${AGENT_HOME}/.local/bin:\${PATH}"`,
    `RUN mkdir -p ${AGENT_HOME}/.claude`,
    `RUN printf '%s' '${settingsJson}' > ${AGENT_HOME}/.claude/settings.json`,
    "",
  ].join("\n");
}

/**
 * No Linux Tenaza binary ships in this image yet; a fixed placeholder keeps this input stable,
 * and a real version changes the tag once.
 */
export const TENAZA_VERSION_PLACEHOLDER = "none";

/** A change to any of the three hashed inputs rebuilds the Agent layer on the next Run. */
export function buildAgentLayerSpec(options: {
  baseImage: string;
  claudeCodeVersion: string;
  tenazaVersion?: string;
}): AgentLayerSpec {
  const { baseImage, claudeCodeVersion, tenazaVersion = TENAZA_VERSION_PLACEHOLDER } = options;
  return {
    tag: `crisol-agent-claude-code:${contentHash([baseImage, claudeCodeVersion, tenazaVersion])}`,
    dockerfile: buildAgentLayerDockerfile({ baseImage, claudeCodeVersion }),
  };
}

const CLAUDE_CLI_FLAGS = ["--dangerously-skip-permissions", "--output-format", "json"];

export interface BuildLaunchArgsOptions {
  binary: string;
  instructions?: string;
}

/**
 * The prompt is not here: it goes over stdin instead (`ctx.sandbox.exec`'s `stdin` argument).
 * `instructions` ride on launch only: a resumed session already carries them in its history.
 */
export function buildLaunchArgs(options: BuildLaunchArgsOptions): string[] {
  const { binary, instructions } = options;
  const args = [binary, "-p", ...CLAUDE_CLI_FLAGS];
  if (instructions !== undefined && instructions.length > 0) {
    args.push("--append-system-prompt", instructions);
  }
  return args;
}

export interface BuildResumeArgsOptions {
  binary: string;
  sessionId: string;
}

/** The feedback goes over stdin too: it carries a Gate's whole output. */
export function buildResumeArgs(options: BuildResumeArgsOptions): string[] {
  const { binary, sessionId } = options;
  return [binary, "-p", "--resume", sessionId, ...CLAUDE_CLI_FLAGS];
}

interface ClaudeCliResult {
  session_id: string;
  /** The agent's last message of the turn. */
  result?: string;
}

/** Output without a `session_id` fails the Run: without it there is no session to resume. */
export function parseCliOutput(stdout: string): ClaudeCliResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Claude Code's --output-format json output was not valid JSON: ${stdout.slice(0, 500)}`);
  }
  const sessionId = (parsed as { session_id?: unknown } | null)?.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(`Claude Code's JSON output had no "session_id" string field: ${stdout.slice(0, 500)}`);
  }
  const result = (parsed as { result?: unknown }).result;
  return typeof result === "string" ? { session_id: sessionId, result } : { session_id: sessionId };
}

interface ClaudeCliFailure {
  is_error?: unknown;
  terminal_reason?: unknown;
  api_error_status?: unknown;
  result?: unknown;
}

/** Drawn from real reports, never guessed. */
const QUOTA_RESULT_PREFIXES = [
  "You've hit your ",
  "You've reached your ",
  "You're out of usage credits",
  "You're out of extra usage",
  "Your org is out of usage",
];

/** No captured envelope for this one: built from the string 2.1.283 itself checks for. */
const CREDIT_TOO_LOW_PATTERN = /credit balance is too low/i;

/** The real envelope's `subtype` field says "success" even on error — don't trust it. */
function turnFailure(binary: string, result: ExecResult): Error {
  let output: ClaudeCliFailure | null = null;
  try {
    output = JSON.parse(result.stdout) as ClaudeCliFailure | null;
  } catch {}
  const text = typeof output?.result === "string" ? output.result : undefined;
  if (output?.is_error === true && output.terminal_reason === "api_error") {
    const status = output.api_error_status;
    if (status === 401) {
      return new ProviderFailureError("auth", text ?? "auth");
    }
    const isQuota =
      (status === 429 && text !== undefined && QUOTA_RESULT_PREFIXES.some((prefix) => text.startsWith(prefix))) ||
      (text !== undefined && CREDIT_TOO_LOW_PATTERN.test(text));
    if (isQuota) {
      return new ProviderFailureError("quota", text ?? "quota");
    }
    if (status === 429) {
      return new ProviderFailureError("rate limit", text ?? "rate limit");
    }
  }
  return new Error(`${binary} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
}

export interface ClaudeCodeAdapterOptions {
  /** Test seam: the suite never calls the real `claude`. */
  binary?: string;
  /** Test seam: the suite never needs `claude` installed. */
  hostVersion?: () => string;
}

/** One instance per Run: `launch`, `continueSession` and `resumeWithFeedback` share its session id. */
export class ClaudeCodeAdapter implements Adapter {
  readonly name = "claude-code";
  private readonly binary: string;
  private readonly hostVersion: () => string;
  private session: string | undefined;
  /**
   * Only the transcripts, which `--resume` looks up by working directory, never the whole
   * `~/.claude`: a mount over that would hide the image's settings.json, attribution off included.
   */
  readonly sessionStore = `${AGENT_HOME}/.claude/projects`;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.hostVersion = options.hostVersion ?? hostClaudeVersion;
  }

  declarePreStart(projectImage: string): PreStartDeclaration {
    const claudeCodeVersion = this.hostVersion();
    const { tag, dockerfile } = buildAgentLayerSpec({ baseImage: projectImage, claudeCodeVersion });
    return {
      envNames: [CLAUDE_TOKEN_SECRET_NAME],
      mounts: [],
      ensureImage: () => ensureImageFromDockerfile(tag, dockerfile),
    };
  }

  async launch(ctx: AdapterContext): Promise<string | void> {
    const args = buildLaunchArgs({ binary: this.binary, instructions: ctx.instructions });
    const result = await ctx.sandbox.exec(args, ctx.prompt);
    if (result.exitCode !== 0) {
      throw turnFailure(this.binary, result);
    }
    return this.takeTurn(result.stdout);
  }

  // `-p` blocks until the turn completes, so the agent has finished by the time we ask.
  async reportCompletion(_ctx: AdapterContext): Promise<boolean> {
    return true;
  }

  async resumeWithFeedback(ctx: AdapterContext, feedback: string): Promise<string | void> {
    if (this.session === undefined) {
      throw new Error("resumeWithFeedback was called before launch ever captured a session id.");
    }
    return this.resume(ctx, this.session, feedback);
  }

  sessionId(): string | undefined {
    return this.session;
  }

  async continueSession(ctx: AdapterContext, sessionId: string, request: string): Promise<string | void> {
    return this.resume(ctx, sessionId, request);
  }

  private async resume(ctx: AdapterContext, sessionId: string, message: string): Promise<string | undefined> {
    const args = buildResumeArgs({ binary: this.binary, sessionId });
    const result = await ctx.sandbox.exec(args, message);
    if (result.exitCode !== 0) {
      throw turnFailure(this.binary, result);
    }
    return this.takeTurn(result.stdout);
  }

  private takeTurn(stdout: string): string | undefined {
    const output = parseCliOutput(stdout);
    this.session = output.session_id;
    return output.result;
  }
}
