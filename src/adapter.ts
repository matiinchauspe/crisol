import type { MountSpec, Sandbox } from "./docker";

/** Consumed at `docker run`: a running container cannot gain env or bind mounts. */
export interface PreStartDeclaration {
  /** Names only: a bare `-e NAME` takes the value from docker's own env, so it never lands on the argv. */
  envNames: readonly string[];
  mounts: readonly MountSpec[];
  /** A closure because the build is async and `declarePreStart` is not. Absent, the Run uses Crisol's base image. */
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
  declarePreStart(): PreStartDeclaration;
  /** Replaces Crisol's default wording. It must name every Gate it is given, or the Run fails before launch. */
  preamble?(gates: readonly string[]): string;
  /** Unattended: no human is in the loop to answer a prompt. */
  launch(ctx: AdapterContext): Promise<void>;
  reportCompletion(ctx: AdapterContext): Promise<boolean>;
  /** Continues the SAME agent session — never a fresh one. */
  resumeWithFeedback(ctx: AdapterContext, feedback: string): Promise<void>;
}
