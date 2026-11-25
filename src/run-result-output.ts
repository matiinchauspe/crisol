import { isInternalHostname, isPlainHostname } from "./network";
import type { Blocked, RunResult, RunStatus } from "./run";
import { readStopLine } from "./stop-line";

/** Past this, a rendered paragraph reads as a wall even on a wide terminal. */
const MAX_COLUMNS = 100;

export interface RunResultView {
  colour: boolean;
  columns: number;
  allowlist: readonly string[];
  /** The Run cut its branch but Fetch-back never brought it into the host repo. */
  awaitsRecover: boolean;
}

/** https://no-color.org: a set, non-empty `NO_COLOR` turns colour off. */
export function colourIsOn(isTTY: boolean | undefined, env: Record<string, string | undefined>): boolean {
  return isTTY === true && (env.NO_COLOR ?? "") === "";
}

export function outputColumns(terminalColumns: number | undefined): number {
  return Math.min(terminalColumns ?? 80, MAX_COLUMNS);
}

/** The host comes from whatever the agent sent, so only a plain hostname is ever printed unquoted. */
export function describeBlocked(entry: Blocked, allowlist: readonly string[]): string {
  const times = entry.count === 1 ? "1 attempt" : `${entry.count} attempts`;
  const plain = isPlainHostname(entry.host);
  const shown = plain ? entry.host : JSON.stringify(entry.host);
  if (entry.port !== undefined) {
    return (
      `${shown}:${entry.port} (${times}). Only HTTPS on 443 and plain HTTP on 80 ` +
      "leave the Sandbox, whatever the Allowlist names."
    );
  }
  if (!plain) {
    return `${shown} (${times}). The Allowlist names plain hostnames only, so there is nothing to allow.`;
  }
  if (isInternalHostname(entry.host)) {
    return `${shown} (${times}). It names a host inside your machine or network, which the Allowlist never opens.`;
  }
  if (allowlist.includes(entry.host)) {
    return `${shown} (${times}). It is already on the Allowlist; the request was refused for its form, not its host.`;
  }
  return (
    `${shown} (${times}). Allow it for every repo, or for this repo only, with:\n` +
    `  crisol allow ${shown}\n` +
    `  crisol allow ${shown} --repo`
  );
}

const STATUS_COLOUR: Record<RunStatus, number> = {
  verified: 32,
  "not-converged": 31,
  unverified: 33,
  parked: 33,
  checkpoint: 33,
};

function paint(text: string, code: number, colour: boolean): string {
  return colour ? `\x1b[${code}m${text}\x1b[39m` : text;
}

/** Agent text may carry escape sequences; only newlines and tabs survive on their way to a terminal. */
function withoutControlBytes(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function indent(text: string, by: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${by}${line}` : line))
    .join("\n");
}

/** Only a trailing Stop line goes: one the agent quotes mid-message is its text. */
function withoutStopLine(finalMessage: string): string {
  if (readStopLine(finalMessage) === undefined) return finalMessage;
  const lines = finalMessage.trimEnd().split("\n");
  return lines.slice(0, -1).join("\n").trimEnd();
}

function renderFinalMessage(finalMessage: string, view: RunResultView): string {
  const message = withoutControlBytes(finalMessage);
  // Without colour, Markdown is already the plain form: backticks and `**` still set code and bold apart.
  if (!view.colour) return message;
  return indent(Bun.markdown.ansi(message, { columns: view.columns - 2 }).trimEnd(), "  ");
}

/** A Run result for a person; `--json` stays the machine's form. */
export function formatRunResult(result: RunResult, view: RunResultView): string {
  const reason = result.reason !== undefined ? ` — ${withoutControlBytes(result.reason)}` : "";
  const iterations = result.iterations === 1 ? "1 iteration" : `${result.iterations} iterations`;
  const status = paint(`${result.status}${reason}`, STATUS_COLOUR[result.status], view.colour);
  const head = [`Run ${result.run}  ${status}  ·  ${iterations}`, `  branch ${result.branch}   (base ${result.base})`];
  if (view.awaitsRecover) {
    head.push(paint("  Not fetched back: `crisol recover` brings the branch in.", 33, view.colour));
  }

  const sections = [head.join("\n")];
  if (result.gates.length > 0) {
    const marks = result.gates.map((gate) => `  ${gate.ok ? paint("✓", 32, view.colour) : paint("✗", 31, view.colour)} ${gate.cmd}`);
    sections.push(["Gates", ...marks].join("\n"));
  }
  if (result.blocked.length > 0) {
    sections.push(["Blocked", ...result.blocked.map((entry) => indent(describeBlocked(entry, view.allowlist), "  "))].join("\n"));
  }
  if (result.warnings.length > 0) {
    sections.push(["Warnings", ...result.warnings.map((warning) => `  ${withoutControlBytes(warning)}`)].join("\n"));
  }
  const message = withoutStopLine(result.finalMessage ?? "");
  if (message.trim() !== "") sections.push(`Final message\n${renderFinalMessage(message, view)}`);
  return sections.join("\n\n");
}
