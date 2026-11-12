import type { Sandbox } from "./docker";

export interface Gate {
  cmd: string;
  ok: boolean;
}

/** What `converge`'s resume message is built from. */
export interface GateFailure {
  cmd: string;
  output: string;
}

export interface GateRunResult {
  /** Never truncated at the first failure. */
  results: Gate[];
  /** The first red Gate, if any; `converge` resumes with only this one. */
  firstFailure?: GateFailure;
}

/** Deliberately never stops at the first red Gate — later Gates still matter for the Run result, even once one has failed. */
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

/** Exported so a test can assert on the exact shape without re-deriving it. */
export function formatGateFeedback(failure: GateFailure): string {
  return `Gate failed: ${failure.cmd}\n\n${failure.output}`;
}

/**
 * Gate ladder: `--gate` beats the repo's `.crisol/config.toml` gates beats none.
 * CLI gates REPLACE the repo's, never merge with them. An empty `--gate` list
 * falls through to the repo rung exactly like `undefined` does.
 */
export function resolveGates(
  cliGates: readonly string[] | undefined,
  repoGates: readonly string[],
): readonly string[] {
  if (cliGates !== undefined && cliGates.length > 0) return cliGates;
  return repoGates;
}
