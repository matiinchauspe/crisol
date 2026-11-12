import type { Adapter, AdapterContext, PreStartDeclaration } from "../adapter";

/**
 * Test double for the agent: runs a script of shell commands inside the Sandbox
 * instead of the real CLI, so the suite costs no quota and never flakes on a model.
 */
export const DEFAULT_SCRIPT: readonly string[] = [
  "echo 'Crisol walking skeleton' >> CRISOL_RUN.md",
  "git add CRISOL_RUN.md",
  "git commit --quiet -m 'feat: record the walking-skeleton run'",
];

/**
 * Leaves GATE_TARGET.txt as "oops" so a Gate checking it stays red.
 * `--allow-empty`: this exact script may run again on resume with nothing new to
 * stage; a plain `git commit` would fail ("nothing to commit") and throw instead
 * of leaving the Gate red for the ceiling to catch.
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

/** Two `-m` flags, not one embedded `\n`: git joins them as separate paragraphs, the same shape a real trailer takes. */
export const CO_AUTHORED_SCRIPT: readonly string[] = [
  "echo 'Crisol walking skeleton' >> CRISOL_RUN.md",
  "git add CRISOL_RUN.md",
  'git commit --quiet -m "feat: record the walking-skeleton run" -m "Co-Authored-By: Claude <noreply@anthropic.com>"',
];

export class FakeAdapter implements Adapter {
  constructor(
    private readonly launchScript: readonly string[] = DEFAULT_SCRIPT,
    /** Reused for EVERY resume call, never advanced through — same script every time. */
    private readonly resumeScript?: readonly string[],
  ) {}

  // Fake Adapter never calls a real provider or wires into Tenaza — nothing to declare.
  declarePreStart(): PreStartDeclaration {
    return { envNames: [], mounts: [] };
  }

  async launch(ctx: AdapterContext): Promise<void> {
    await this.runScript(ctx, this.launchScript);
  }

  // Synchronous: launch/resumeWithFeedback already finished by the time this is called.
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
