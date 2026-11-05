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

export class FakeAdapter implements Adapter {
  constructor(private readonly script: readonly string[] = DEFAULT_SCRIPT) {}

  // No secret, no Tenaza mount, no custom image — the fake Adapter never
  // calls a real provider and Tenaza doesn't wire into it (spec q5/q6 are
  // moot for it); it contributes nothing to the pre-start declaration.
  declarePreStart(): PreStartDeclaration {
    return { envNames: [], mounts: [] };
  }

  async launch(ctx: AdapterContext): Promise<void> {
    for (const line of this.script) {
      const result = await ctx.sandbox.exec(["bash", "-c", line]);
      if (result.exitCode !== 0) {
        throw new Error(`FakeAdapter script step "${line}" failed: ${result.stderr.trim()}`);
      }
    }
  }

  // Scripted and synchronous: by the time `launch` returns, the fake agent is done.
  async reportCompletion(_ctx: AdapterContext): Promise<boolean> {
    return true;
  }

  async resumeWithFeedback(_ctx: AdapterContext, _feedback: string): Promise<void> {
    throw new Error(
      "FakeAdapter's default script never needs to resume — it always succeeds on launch.",
    );
  }
}
