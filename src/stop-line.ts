/** Why an agent stopped on purpose; each one is also the Run result's `status`. */
export type StopReason = "parked" | "checkpoint";

const STOP_REASONS: readonly StopReason[] = ["parked", "checkpoint"];

export function stopLine(reason: StopReason): string {
  return `CRISOL-STOP: ${reason}`;
}

/** Only the last non-blank line counts, so a Stop line the agent quotes mid-message never stops a Run. */
export function readStopLine(finalMessage: string): StopReason | undefined {
  const lastLine = finalMessage.trimEnd().split("\n").at(-1)?.trim();
  return STOP_REASONS.find((reason) => lastLine === stopLine(reason));
}
