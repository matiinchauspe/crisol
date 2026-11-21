import type { MountSpec, Sandbox } from "./docker";

/** Consumed at `docker run`: a running container cannot gain env or bind mounts. */
export interface PreStartDeclaration {
  /** Names only: a bare `-e NAME` takes the value from docker's own env, so it never lands on the argv. */
  envNames: readonly string[];
  mounts: readonly MountSpec[];
  /** A closure because the build is async and `declarePreStart` is not. Absent, the Run uses the Project layer directly. */
  ensureImage?: () => Promise<string>;
}

export interface AdapterContext {
  sandbox: Sandbox;
  /** Identical path inside and outside the Sandbox. */
  repoPath: string;
  /** The full prompt — Preamble, Task and Context — to send the agent over stdin, never argv. */
  prompt: string;
  /** `~/.crisol/instructions.md`, when present; the global `~/.claude/CLAUDE.md` never reaches a Run. */
  instructions?: string;
}

export interface Adapter {
  /**
   * Identity Crisol records on the Run result and compares on a Continuation. Every Adapter a
   * caller names by that identity (`fake`, `claude-code`) sets it; a one-off test stand-in with no
   * identity of its own, and no `continueSession`, has no need to.
   */
  readonly name?: string;
  /** `projectImage` is the resolved Project layer's tag; the Agent layer, if any, builds `FROM` it. */
  declarePreStart(projectImage: string): PreStartDeclaration;
  /** Replaces Crisol's default wording. It must name every Gate it is given, or the Run fails before launch. */
  preamble?(gates: readonly string[]): string;
  /**
   * Unattended: no human is in the loop to answer a prompt. Resolves with the agent's last message
   * of the turn, verbatim, or with nothing when the Adapter cannot read one.
   */
  launch(ctx: AdapterContext): Promise<string | void>;
  reportCompletion(ctx: AdapterContext): Promise<boolean>;
  /** Continues the SAME agent session — never a fresh one. Resolves as `launch` does. */
  resumeWithFeedback(ctx: AdapterContext, feedback: string): Promise<string | void>;
  /**
   * Where inside the Sandbox the agent keeps its sessions. Crisol mounts a dir of the Run's over
   * it, so the session outlives the Sandbox and a Continuation finds it again.
   */
  readonly sessionStore?: string;
  /** The session the last turn ran in, which Crisol keeps in the Run dir for a Continuation. */
  sessionId?(): string | undefined;
  /**
   * A Continuation's first turn: resumes `sessionId`, kept from an earlier Sandbox, with a new
   * request, then resumes it on a red Gate as usual. An Adapter without it cannot continue a Run.
   * Resolves as `launch` does.
   */
  continueSession?(ctx: AdapterContext, sessionId: string, request: string): Promise<string | void>;
}

/**
 * Thrown from any turn (`launch`, `resumeWithFeedback`, `continueSession`) when the agent CLI itself
 * refuses to proceed — a rate limit, an exhausted quota, or a failed authentication — never a red
 * Gate. Only the Adapter
 * can tell the two apart, so classifying one is its job: `category` becomes the Run result's
 * `reason: "provider: <category>"`, and the Run stops without spending another iteration on it.
 */
export class ProviderFailureError extends Error {
  constructor(
    readonly category: string,
    message: string = category,
  ) {
    super(message);
    this.name = "ProviderFailureError";
  }
}
