import type { MountSpec, Sandbox } from "./docker";

/**
 * Everything the Sandbox needs BEFORE it starts — consumed ONCE by
 * `startSandbox`, never by `exec` after the container is already running.
 * Reshaped from the original post-start `authenticate`/`wireHooks` calls
 * (see docs/adr/0001, superseded in part by docs/adr/0005) because the
 * token needs to be Sandbox env at `docker run` time (ticket 08), Tenaza's
 * mounts need to exist at `docker run` time (ticket 15), and (a later
 * ticket) the Agent layer image will need to be chosen at `docker run`
 * time too (tickets 12/14) — none of that can be bolted on after the
 * container is already running. This declaration has no `image` field YET
 * (round-2 review, cheap extra): until ticket 12's two-layer build exists
 * to define one, `run.ts` always runs Crisol's own base image.
 *
 * The spec's five Adapter points stay identifiable even though two of them
 * no longer run against a live Sandbox: `authenticate` and `wireHooks`
 * CONTRIBUTE to this declaration's fields instead.
 */
export interface PreStartDeclaration {
  /** authenticate (spec q5 / ticket 08): secret env var NAMES the agent needs — e.g. `CLAUDE_CODE_OAUTH_TOKEN` for the real Adapter, none for the fake one. NEVER values: `startSandbox` passes these as a bare `-e NAME` and reads the value from the spawned docker process's own env, so a secret's value never lands on the docker argv. */
  envNames: readonly string[];
  /** wireHooks (spec "Tenaza inside" / ticket 15): the mounts that wire the agent's hooks to Tenaza (`~/.tenaza/config:ro`, `~/.tenaza/state:rw`) — empty until Tenaza rides inside. */
  mounts: readonly MountSpec[];
  // No `image` field here (round-2 review, cheap extra): the Agent layer
  // image an Adapter would contribute (tickets 12/14/17) is deferred until
  // ticket 12's two-layer build exists to define it. `run.ts` always uses
  // `ensureBaseImage()` until then.
}

export interface AdapterContext {
  /** The Run's Sandbox — already started, the Clone already bind-mounted at `repoPath`, and everything the Adapter declared pre-start already wired in. */
  sandbox: Sandbox;
  /** The Clone's absolute path, identical inside and outside the Sandbox (spec q6). */
  repoPath: string;
  /** The Task text. Preamble prepending (spec, "Input and output" q9) is a later ticket. */
  task: string;
}

export interface Adapter {
  /** Declares env names and mounts — read by `startSandbox` BEFORE `docker run` ever executes. */
  declarePreStart(): PreStartDeclaration;
  /** Launches the agent unattended inside the already-started Sandbox and lets it work (and, for a real Adapter, commit). */
  launch(ctx: AdapterContext): Promise<void>;
  /** True once the agent has finished its turn. */
  reportCompletion(ctx: AdapterContext): Promise<boolean>;
  /** Continues the SAME agent session with feedback (a failing Gate's output) — not exercised until Gates exist (ticket 01 has none). */
  resumeWithFeedback(ctx: AdapterContext, feedback: string): Promise<void>;
}
