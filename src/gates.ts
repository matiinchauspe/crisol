import type { Sandbox } from "./docker";

export interface Gate {
  cmd: string;
  ok: boolean;
}

/** A red Gate's command and its combined stdout+stderr — what `converge`'s resume message is built from. */
export interface GateFailure {
  cmd: string;
  output: string;
}

export interface GateRunResult {
  /** Every declared Gate this iteration actually ran, in order — never truncated at the first failure. */
  results: Gate[];
  /** The FIRST red Gate found this iteration, if any. `converge` resumes with ONLY this one. */
  firstFailure?: GateFailure;
}

/**
 * Runs every declared Gate, in order, inside the already-started Sandbox.
 * Deliberately never stops at the first red Gate — a later Gate might
 * still be worth knowing about even once an earlier one has failed, and
 * the Run result's own `gates` array is expected to reflect every Gate
 * this iteration touched, not just the one `firstFailure` singles out for
 * the resume message.
 */
export async function runGates(
  sandbox: Sandbox,
  gates: readonly string[],
): Promise<GateRunResult> {
  const results: Gate[] = [];
  let firstFailure: GateFailure | undefined;
  for (const cmd of gates) {
    const execResult = await sandbox.exec(["bash", "-c", cmd]);
    const ok = execResult.exitCode === 0;
    results.push({ cmd, ok });
    if (!ok && firstFailure === undefined) {
      firstFailure = { cmd, output: `${execResult.stdout}${execResult.stderr}`.trim() };
    }
  }
  return { results, firstFailure };
}

/**
 * The resume message a red Gate produces. Exported so a test can assert
 * on its exact shape without re-deriving it.
 */
export function formatGateFeedback(failure: GateFailure): string {
  return `Gate failed: ${failure.cmd}\n\n${failure.output}`;
}

/**
 * The Gate ladder: `--gate` (repeatable) beats the repo's own
 * `.crisol/config.toml` `gates = […]` beats none. A weaker rung never
 * substitutes for a stronger one — so ANY `--gate` passed on the CLI
 * replaces the repo's declared Gates entirely, it never merges with them.
 * An explicit empty `--gate` list (i.e. none passed) falls through to the
 * repo rung exactly like `undefined` does.
 */
export function resolveGates(
  cliGates: readonly string[] | undefined,
  repoGates: readonly string[],
): readonly string[] {
  if (cliGates !== undefined && cliGates.length > 0) return cliGates;
  return repoGates;
}
