import type { Adapter, AdapterContext, PreStartDeclaration } from "../adapter";
import { SKELETON_IMAGE_TAG, ensureImageFromDockerfile } from "../docker";
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

/** Computed, not built, so `declarePreStart` stays sync. */
export function buildAgentLayerSpec(options: { baseImage: string; claudeCodeVersion: string }): AgentLayerSpec {
  const { baseImage, claudeCodeVersion } = options;
  return {
    tag: `crisol-agent-claude-code:${claudeCodeVersion}`,
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
  return { session_id: sessionId };
}

export interface ClaudeCodeAdapterOptions {
  /** Test seam: the suite never calls the real `claude`. */
  binary?: string;
  /** Test seam: the suite never needs `claude` installed. */
  hostVersion?: () => string;
}

/** One instance per Run: `launch` and `resumeWithFeedback` share its session id. */
export class ClaudeCodeAdapter implements Adapter {
  private readonly binary: string;
  private readonly hostVersion: () => string;
  private sessionId: string | undefined;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.hostVersion = options.hostVersion ?? hostClaudeVersion;
  }

  declarePreStart(): PreStartDeclaration {
    const claudeCodeVersion = this.hostVersion();
    const { tag, dockerfile } = buildAgentLayerSpec({ baseImage: SKELETON_IMAGE_TAG, claudeCodeVersion });
    return {
      envNames: [CLAUDE_TOKEN_SECRET_NAME],
      mounts: [],
      ensureImage: () => ensureImageFromDockerfile(tag, dockerfile),
    };
  }

  async launch(ctx: AdapterContext): Promise<void> {
    const args = buildLaunchArgs({ binary: this.binary, instructions: ctx.instructions });
    const result = await ctx.sandbox.exec(args, ctx.prompt);
    if (result.exitCode !== 0) {
      throw new Error(`${this.binary} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
    }
    this.sessionId = parseCliOutput(result.stdout).session_id;
  }

  // `-p` blocks until the turn completes, so the agent has finished by the time we ask.
  async reportCompletion(_ctx: AdapterContext): Promise<boolean> {
    return true;
  }

  async resumeWithFeedback(ctx: AdapterContext, feedback: string): Promise<void> {
    if (this.sessionId === undefined) {
      throw new Error("resumeWithFeedback was called before launch ever captured a session id.");
    }
    const args = buildResumeArgs({ binary: this.binary, sessionId: this.sessionId });
    const result = await ctx.sandbox.exec(args, feedback);
    if (result.exitCode !== 0) {
      throw new Error(`${this.binary} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
    }
    this.sessionId = parseCliOutput(result.stdout).session_id;
  }
}
