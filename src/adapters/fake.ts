import type { Adapter, AdapterContext, PreStartDeclaration } from "../adapter";

/**
 * The test double for the agent (spec, "Testing Decisions"): a script of
 * shell commands run INSIDE the Sandbox, never the real Claude Code CLI —
 * so the suite costs no quota and never flakes on a model. Ticket 01's own
 * default script is the simplest scenario the spec names there: "succeed
 * at once" — edit a file and commit. Later tickets' richer scenarios
 * (fail-then-fix, never-converge, rate-limit, blocked-host,
 * Co-Authored-By) are a different script passed to the SAME constructor —
 * this ticket adds no behaviour those don't need yet.
 */
export const DEFAULT_SCRIPT: readonly string[] = [
  "echo 'Crisol walking skeleton' >> CRISOL_RUN.md",
  "git add CRISOL_RUN.md",
  "git commit --quiet -m 'feat: record the walking-skeleton run'",
];

/**
 * Leaves `GATE_TARGET.txt` holding "oops" — a Gate checking its content
 * (e.g. `[ "$(cat GATE_TARGET.txt)" = ok ]`) stays red after this.
 * `--allow-empty` so re-running this EXACT script on a later
 * `resumeWithFeedback` call (the "never converge" scenario reuses it as
 * both the launch AND the resume script) always succeeds even once there
 * is nothing new to stage — a plain `git commit` would fail with "nothing
 * to commit" the second time around, which would make the Adapter throw
 * instead of the Gate staying red for the ceiling to catch.
 */
export const GATE_FAILING_SCRIPT: readonly string[] = [
  "echo 'oops' > GATE_TARGET.txt",
  "git add GATE_TARGET.txt",
  "git commit --quiet --allow-empty -m 'feat: attempt (Gate still red)'",
];

/** Fixes what `GATE_FAILING_SCRIPT` leaves red — paired as the `resumeScript` for the "fail then fix on resume" scenario. */
export const GATE_FIXING_SCRIPT: readonly string[] = [
  "echo 'ok' > GATE_TARGET.txt",
  "git add GATE_TARGET.txt",
  "git commit --quiet -m 'fix: make the Gate green'",
];

export class FakeAdapter implements Adapter {
  constructor(
    private readonly launchScript: readonly string[] = DEFAULT_SCRIPT,
    /**
     * The script `resumeWithFeedback` runs — reused for EVERY resume call,
     * never advanced through (the "never converge" scenario passes the
     * SAME script here as `launchScript`, so each resume repeats the
     * identical failing attempt forever). `undefined` (the default) means
     * this Adapter is never expected to be resumed at all — the "succeed at
     * once" scenario, where the Gate is already green on the first attempt.
     */
    private readonly resumeScript?: readonly string[],
  ) {}

  // No secret, no Tenaza mount, no custom image — the fake Adapter never
  // calls a real provider and Tenaza doesn't wire into it (spec q5/q6 are
  // moot for it); it contributes nothing to the pre-start declaration.
  declarePreStart(): PreStartDeclaration {
    return { envNames: [], mounts: [] };
  }

  async launch(ctx: AdapterContext): Promise<void> {
    await this.runScript(ctx, this.launchScript);
  }

  // Scripted and synchronous: by the time `launch` (or `resumeWithFeedback`)
  // returns, the fake agent's turn is done.
  async reportCompletion(_ctx: AdapterContext): Promise<boolean> {
    return true;
  }

  async resumeWithFeedback(ctx: AdapterContext, _feedback: string): Promise<void> {
    if (this.resumeScript === undefined) {
      throw new Error(
        "This FakeAdapter has no resumeScript — it was not expected to be resumed " +
          "(the 'succeed at once' scenario's Gate should already be green on the first attempt).",
      );
    }
    await this.runScript(ctx, this.resumeScript);
  }

  private async runScript(ctx: AdapterContext, script: readonly string[]): Promise<void> {
    for (const line of script) {
      const result = await ctx.sandbox.exec(["bash", "-c", line]);
      if (result.exitCode !== 0) {
        throw new Error(`FakeAdapter script step "${line}" failed: ${result.stderr.trim()}`);
      }
    }
  }
}
