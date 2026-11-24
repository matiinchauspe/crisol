import { ProviderFailureError, type Adapter, type AdapterContext, type PreStartDeclaration } from "../adapter";
import { existsSync } from "node:fs";
import { assertInstallableBase, contentHash, ensureImageFromDockerfile, installPackagesStep, type ExecResult } from "../docker";
import { CLAUDE_TOKEN_SECRET_NAME } from "../secret-store";
import {
  TENAZA_RELEASE,
  hostTenazaHome,
  startTenazaRelay,
  tenazaLayerSteps,
  tenazaMounts,
  tenazaSessionsDir,
  type TenazaRelease,
} from "../tenaza";

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
 * `USE_BUILTIN_RIPGREP: "0"` because the bundled ripgrep targets glibc and an Alpine image is musl.
 */
const AGENT_SETTINGS = {
  attribution: { commit: "", pr: "", sessionUrl: false },
  env: { USE_BUILTIN_RIPGREP: "0" },
};

/**
 * A real account, not a bare numeric `-u`, so `$HOME` resolves for every tool, Claude Code included.
 * Where an image already holds uid 1000 (`node`, `ubuntu`), that account is dropped and its files pass to `agent`.
 */
const AGENT_USER = "agent";
const AGENT_UID = 1000;
const AGENT_HOME = "/home/agent";
const AGENT_TENAZA_HOME = `${AGENT_HOME}/.tenaza`;

const TENAZA_HOOK = { type: "command", command: "tenaza hook claude" };

/**
 * The events and matchers of Tenaza's own Claude Code plugin (`hooks/hooks.json`). Its PreToolUse
 * guard for a missing binary is left out: the binary is baked into this same layer, and the guard's
 * single quotes cannot ride inside the single-quoted `printf` that writes settings.json.
 */
const TENAZA_HOOKS = {
  SessionStart: [{ hooks: [TENAZA_HOOK] }],
  SubagentStart: [{ hooks: [TENAZA_HOOK] }],
  // A reserved action waits here for the human's answer, so it gets Tenaza's own long timeout.
  PreToolUse: [{ matcher: "Bash|mcp__.*", hooks: [{ ...TENAZA_HOOK, timeout: 240 }] }],
  PostToolUse: [{ hooks: [TENAZA_HOOK] }],
  SubagentStop: [{ hooks: [TENAZA_HOOK] }],
  Stop: [{ hooks: [TENAZA_HOOK] }],
  SessionEnd: [{ hooks: [TENAZA_HOOK] }],
  UserPromptSubmit: [{ hooks: [TENAZA_HOOK] }],
  Notification: [{ matcher: "permission_prompt|idle_prompt", hooks: [TENAZA_HOOK] }],
};

export interface AgentLayerSpec {
  tag: string;
  dockerfile: string;
}

/**
 * Pinned to the host's exact Claude Code version, so a Gate never passes or fails on version
 * drift. Non-root, because Claude Code refuses `--dangerously-skip-permissions` as root. No
 * `COPY`: the image is built from stdin, with no build context. Builds only on an Alpine, Debian or
 * Ubuntu Project layer.
 */
export function buildAgentLayerDockerfile(options: {
  baseImage: string;
  claudeCodeVersion: string;
  tenaza?: TenazaRelease;
}): string {
  const { baseImage, claudeCodeVersion, tenaza } = options;
  if (!PLAIN_VERSION.test(claudeCodeVersion)) {
    throw new Error(
      `"${claudeCodeVersion}" is not a plain "X.Y.Z" version; refusing to embed it in a Dockerfile RUN step.`,
    );
  }
  // No single quotes in this JSON, so the whole blob is safe inside a single-quoted shell argument.
  const settingsJson = JSON.stringify(tenaza !== undefined ? { ...AGENT_SETTINGS, hooks: TENAZA_HOOKS } : AGENT_SETTINGS);
  return [
    `FROM ${baseImage}`,
    // A Project layer may end on its own `USER`, and installing packages needs root.
    "USER root",
    // `libgcc`/`libstdc++` are what Claude Code's docs require on Alpine/musl; glibc images carry
    // both already. `git` and `bash` because Crisol itself runs them inside the Sandbox.
    installPackagesStep({
      apk: ["bash", "ca-certificates", "curl", "git", "libgcc", "libstdc++", "ripgrep"],
      apt: ["bash", "ca-certificates", "curl", "git", "ripgrep"],
    }),
    // As root, before `USER`: the binary lands in /usr/local/bin.
    ...(tenaza !== undefined ? tenazaLayerSteps(tenaza, AGENT_TENAZA_HOME) : []),
    [
      `RUN taken="$(awk -F: '$3 == ${AGENT_UID} { print $1 }' /etc/passwd)"`,
      '&& if [ -n "$taken" ]; then if command -v userdel >/dev/null 2>&1; then userdel "$taken"; else deluser "$taken"; fi; fi',
      // BusyBox's `adduser` needs `-D`, or it prompts for a password the build has no stdin to answer.
      `&& if command -v useradd >/dev/null 2>&1; then useradd -m -d ${AGENT_HOME} -s /bin/bash -u ${AGENT_UID} ${AGENT_USER};`,
      `else adduser -D -h ${AGENT_HOME} -s /bin/bash -u ${AGENT_UID} ${AGENT_USER}; fi`,
    ].join(" "),
    `USER ${AGENT_USER}`,
    `ENV HOME="${AGENT_HOME}"`,
    `RUN curl -fsSL https://claude.ai/install.sh | bash -s ${claudeCodeVersion}`,
    `ENV PATH="${AGENT_HOME}/.local/bin:\${PATH}"`,
    `RUN mkdir -p ${AGENT_HOME}/.claude`,
    `RUN printf '%s' '${settingsJson}' > ${AGENT_HOME}/.claude/settings.json`,
    "",
  ].join("\n");
}

/** Hashed in Tenaza's place when it is absent, so a layer without it keeps the tag it always had. */
export const TENAZA_VERSION_PLACEHOLDER = "none";

/** A change to any of the three hashed inputs rebuilds the Agent layer on the next Run. */
export function buildAgentLayerSpec(options: {
  baseImage: string;
  claudeCodeVersion: string;
  tenaza?: TenazaRelease;
}): AgentLayerSpec {
  const { baseImage, claudeCodeVersion, tenaza } = options;
  const tenazaVersion = tenaza?.version ?? TENAZA_VERSION_PLACEHOLDER;
  return {
    tag: `crisol-agent-claude-code:${contentHash([baseImage, claudeCodeVersion, tenazaVersion])}`,
    dockerfile: buildAgentLayerDockerfile({ baseImage, claudeCodeVersion, tenaza }),
  };
}

const CLAUDE_CLI_FLAGS = ["--dangerously-skip-permissions", "--output-format", "json"];

export interface BuildLaunchArgsOptions {
  binary: string;
  instructions?: string;
  /** Chosen before launch, so Tenaza can label the session before the agent's first hook fires. */
  sessionId?: string;
}

/**
 * The prompt is not here: it goes over stdin instead (`ctx.sandbox.exec`'s `stdin` argument).
 * `instructions` ride on launch only: a resumed session already carries them in its history.
 */
export function buildLaunchArgs(options: BuildLaunchArgsOptions): string[] {
  const { binary, instructions, sessionId } = options;
  const args = [binary, "-p", ...CLAUDE_CLI_FLAGS];
  if (sessionId !== undefined) {
    args.push("--session-id", sessionId);
  }
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
  /** Test seam: the suite never reads the real `~/.tenaza`. */
  tenazaHome?: string;
}

/** `tenaza label` splits its pairs on whitespace, so a path with any would be cut short. */
const LABELLABLE_PATH = /^\S+$/;

/** One instance per Run: `launch`, `continueSession` and `resumeWithFeedback` share its session id. */
export class ClaudeCodeAdapter implements Adapter {
  readonly name = "claude-code";
  private readonly binary: string;
  private readonly hostVersion: () => string;
  private readonly tenazaHome: string;
  private tenaza = false;
  private session: string | undefined;
  /**
   * Only the transcripts, which `--resume` looks up by working directory, never the whole
   * `~/.claude`: a mount over that would hide the image's settings.json, attribution off included.
   */
  readonly sessionStore = `${AGENT_HOME}/.claude/projects`;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.hostVersion = options.hostVersion ?? hostClaudeVersion;
    this.tenazaHome = options.tenazaHome ?? hostTenazaHome();
  }

  declarePreStart(projectImage: string): PreStartDeclaration {
    const claudeCodeVersion = this.hostVersion();
    this.tenaza = existsSync(this.tenazaHome);
    const tenaza = this.tenaza ? TENAZA_RELEASE : undefined;
    const { tag, dockerfile } = buildAgentLayerSpec({ baseImage: projectImage, claudeCodeVersion, tenaza });
    return {
      envNames: [CLAUDE_TOKEN_SECRET_NAME],
      mounts: this.tenaza ? tenazaMounts(this.tenazaHome, AGENT_TENAZA_HOME) : [],
      ensureImage: () =>
        ensureImageFromDockerfile(tag, dockerfile, { beforeBuild: () => assertInstallableBase(projectImage) }),
      ...(this.tenaza
        ? {
            eventSink: {
              containerPath: tenazaSessionsDir(AGENT_TENAZA_HOME),
              start: (paths, onRefused) => startTenazaRelay({ ...paths, hostHome: this.tenazaHome, onRefused }),
            },
          }
        : { unguarded: `no Tenaza home at ${this.tenazaHome}` }),
    };
  }

  async launch(ctx: AdapterContext): Promise<string | void> {
    let sessionId: string | undefined;
    if (this.tenaza) {
      sessionId = crypto.randomUUID();
      await this.labelProject(ctx, sessionId);
    }
    const args = buildLaunchArgs({ binary: this.binary, instructions: ctx.instructions, sessionId });
    const result = await ctx.sandbox.exec(args, ctx.prompt);
    if (result.exitCode !== 0) {
      throw turnFailure(this.binary, result);
    }
    return this.takeTurn(result.stdout);
  }

  /**
   * Hands Tenaza's hook the same `tenaza label` call a session makes for itself, so the board
   * groups the Run under the host repo rather than the Clone. Best-effort: a missing label costs
   * the board grouping, never the reserved-action guard.
   */
  private async labelProject(ctx: AdapterContext, sessionId: string): Promise<void> {
    if (!LABELLABLE_PATH.test(ctx.hostRepoPath)) return;
    const payload = {
      session_id: sessionId,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `tenaza label project=${ctx.hostRepoPath}` },
      cwd: ctx.repoPath,
    };
    await ctx.sandbox.exec(["tenaza", "hook", "claude"], JSON.stringify(payload));
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
