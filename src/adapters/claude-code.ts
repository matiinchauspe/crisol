import type { Adapter, AdapterContext, PreStartDeclaration } from "../adapter";
import { SKELETON_IMAGE_TAG, ensureImageFromDockerfile } from "../docker";
import { CLAUDE_TOKEN_SECRET_NAME } from "../secret-store";

const VERSION_PATTERN = /^(\d+\.\d+\.\d+)/;
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * `claude --version` prints e.g. `2.1.283 (Claude Code)`; only the leading `X.Y.Z` is the
 * version. Exported for a direct unit test against a real captured string — never the real
 * CLI itself.
 */
export function parseClaudeVersionOutput(raw: string): string {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (!match || match[1] === undefined) {
    throw new Error(`Could not parse a Claude Code version from \`claude --version\` output: "${raw.trim()}".`);
  }
  return match[1];
}

/** The only place the real `claude` binary is invoked for its version — harmless, never the agent itself. */
function hostClaudeVersion(): string {
  const proc = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`\`claude --version\` failed: ${proc.stderr.toString("utf8").trim()}`);
  }
  return parseClaudeVersionOutput(proc.stdout.toString("utf8"));
}

/**
 * Attribution disabled BY CONFIGURATION — baked into the image's user settings.json — never
 * by asking the model via the Preamble. `attribution.commit`/`.pr` take the trailer STRING to
 * use — empty string hides it — never a boolean; only `sessionUrl` is one. Checked against
 * the published schema (json.schemastore.org/claude-code-settings.json): `claude doctor` run
 * against an earlier, boolean version of this file flagged both as the wrong type.
 * `USE_BUILTIN_RIPGREP: "0"` is required on Alpine/musl per Claude Code's own install docs,
 * since Alpine's `ripgrep` is installed separately below, not the glibc binary Claude bundles.
 */
const AGENT_SETTINGS = {
  attribution: { commit: "", pr: "", sessionUrl: false },
  env: { USE_BUILTIN_RIPGREP: "0" },
};

/** A real `adduser`-created account, not an arbitrary numeric `-u`, so `$HOME` resolves the normal way (no passwd entry, no lookup) for every tool that reads it, Claude Code included. */
const AGENT_USER = "agent";
const AGENT_UID = 1000;
const AGENT_HOME = "/home/agent";

export interface AgentLayerSpec {
  tag: string;
  dockerfile: string;
}

/**
 * Pure: the Agent layer Dockerfile text, FROM a base image, with Claude Code's native
 * installer pinned to the EXACT version the host reports — never "latest", since a version
 * drift between what the human runs locally and what the Sandbox runs would make a Gate
 * pass or fail differently for reasons that have nothing to do with the Task — and the
 * attribution-off settings.json written in. Runs as a non-root `agent` user: Claude Code
 * itself refuses `--dangerously-skip-permissions` under root/sudo, and an unattended Run has
 * no human to drop the flag for. No `COPY`: `ensureImageFromDockerfile` builds from stdin
 * with no build context, so every instruction here is a `FROM`, `RUN`, `ENV` or `USER`.
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
    // Runtime deps the native installer needs on Alpine/musl (Claude Code's own docs,
    // "Alpine Linux and musl-based distributions"): curl to fetch it, libgcc/libstdc++ for
    // the native binary, ripgrep since the bundled one targets glibc.
    "RUN apk add --no-cache curl libgcc libstdc++ ripgrep",
    // `-D`: no password prompt needed in a container nobody logs into interactively.
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

/** Pure: the tag plus the Dockerfile it was built from, so `declarePreStart` stays sync. */
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
  task: string;
  instructions?: string;
}

/**
 * Pure. `instructions` (the content of `~/.crisol/instructions.md`, when present) rides
 * `--append-system-prompt` on launch only — a resumed session already carries it in its own
 * history, so repeating it on every resume would just duplicate it turn after turn. The
 * Preamble itself is not implemented anywhere yet (`AdapterContext.task` is raw text), so
 * there is nothing here for the Adapter to tune.
 */
export function buildLaunchArgs(options: BuildLaunchArgsOptions): string[] {
  const { binary, task, instructions } = options;
  const args = [binary, "-p", task, ...CLAUDE_CLI_FLAGS];
  if (instructions !== undefined && instructions.length > 0) {
    args.push("--append-system-prompt", instructions);
  }
  return args;
}

export interface BuildResumeArgsOptions {
  binary: string;
  sessionId: string;
  feedback: string;
}

/** Pure. `--resume <sessionId>` is what continues the SAME Claude Code session, never a fresh one. */
export function buildResumeArgs(options: BuildResumeArgsOptions): string[] {
  const { binary, sessionId, feedback } = options;
  return [binary, "-p", feedback, "--resume", sessionId, ...CLAUDE_CLI_FLAGS];
}

interface ClaudeCliResult {
  session_id: string;
}

/** `--output-format json`'s stable shape includes `session_id`; anything else is a Run-level failure, never silently ignored. */
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
  /** Overrides the binary name invoked inside the Sandbox — the test seam, since the real `claude` CLI is never called by the suite. Default: `"claude"`. */
  binary?: string;
  /** Overrides the host `claude --version` probe — the test seam, since the suite never depends on `claude` being installed on whatever machine runs it. */
  hostVersion?: () => string;
}

/**
 * The real Adapter: the only code here that knows Claude Code specifically. One instance
 * per Run — `launch` and `resumeWithFeedback` share its captured session id, never a fresh
 * one per call.
 */
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
      // Nothing to mount yet — wired once Tenaza's hooks ride inside the Sandbox.
      mounts: [],
      ensureImage: () => ensureImageFromDockerfile(tag, dockerfile),
    };
  }

  async launch(ctx: AdapterContext): Promise<void> {
    const args = buildLaunchArgs({ binary: this.binary, task: ctx.task, instructions: ctx.instructions });
    const result = await ctx.sandbox.exec(args);
    if (result.exitCode !== 0) {
      throw new Error(`${this.binary} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
    }
    this.sessionId = parseCliOutput(result.stdout).session_id;
  }

  // `-p` already blocks until the turn completes, so by the time `launch`/`resumeWithFeedback`
  // resolve the agent has already finished — same reasoning as the fake Adapter.
  async reportCompletion(_ctx: AdapterContext): Promise<boolean> {
    return true;
  }

  async resumeWithFeedback(ctx: AdapterContext, feedback: string): Promise<void> {
    if (this.sessionId === undefined) {
      throw new Error("resumeWithFeedback was called before launch ever captured a session id.");
    }
    const args = buildResumeArgs({ binary: this.binary, sessionId: this.sessionId, feedback });
    const result = await ctx.sandbox.exec(args);
    if (result.exitCode !== 0) {
      throw new Error(`${this.binary} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
    }
    this.sessionId = parseCliOutput(result.stdout).session_id;
  }
}
