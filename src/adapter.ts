import type { MountSpec, Sandbox } from "./docker";

/**
 * Everything the Sandbox needs before it starts, consumed once by `startSandbox` — never
 * by `exec` after the container is running, since the token must be Sandbox env and mounts
 * must exist at `docker run` time; neither can be bolted on afterward. `authenticate` and
 * `wireHooks` contribute to these fields instead of running against a live Sandbox.
 */
export interface PreStartDeclaration {
  /** Secret env var NAMES only, never values — passed as a bare `-e NAME` so the value is read from the spawned docker process's own env and never lands on the docker argv. */
  envNames: readonly string[];
  /** Empty until Tenaza rides inside; then wires the agent's hooks to Tenaza's config/state mounts. */
  mounts: readonly MountSpec[];
  /**
   * Ensures the Agent layer image exists (building it if missing) and resolves to its tag —
   * a closure, not a plain string, because the build itself is async while `declarePreStart`
   * is not. Undefined (the fake Adapter, and any Adapter with nothing to layer) falls through
   * to Crisol's own base image in `run.ts`.
   */
  ensureImage?: () => Promise<string>;
}

export interface AdapterContext {
  /** Already started: Clone bind-mounted at `repoPath`, everything pre-start already wired in. */
  sandbox: Sandbox;
  /** Identical path inside and outside the Sandbox. */
  repoPath: string;
  /** Raw text; preamble prepending not yet implemented. */
  task: string;
  /** `~/.crisol/instructions.md`'s content, when present — never the global `~/.claude/CLAUDE.md`, which is not mounted. */
  instructions?: string;
}

export interface Adapter {
  /** Read by `startSandbox` before `docker run` executes. */
  declarePreStart(): PreStartDeclaration;
  /** Launches the agent unattended — no human in the loop. */
  launch(ctx: AdapterContext): Promise<void>;
  reportCompletion(ctx: AdapterContext): Promise<boolean>;
  /** Continues the SAME agent session — never a fresh one. */
  resumeWithFeedback(ctx: AdapterContext, feedback: string): Promise<void>;
}
