import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addToRepoAllowlist, hostsToLearn, learnBaseline } from "./allowlist";
import { detectPackageManager } from "./dependencies";
import { REPO_CONFIG_FILE, repoAllowlistPath } from "./paths";
import type { RunResult } from "./run";

export { REPO_CONFIG_FILE };

/** Cheapest first, so a red Gate fails before the slow ones run. */
const GATE_SCRIPTS = ["typecheck", "lint", "test"] as const;

/** `npm init`'s placeholder `test` script exits 1 on purpose; as a Gate it would never go green. */
const NPM_PLACEHOLDER_TEST = "no test specified";

export const SANDBOX_HEADING = "## Sandbox";

export const SANDBOX_BLOCK = `${SANDBOX_HEADING}

This repo runs one Task at a time in an isolated Sandbox with Crisol, which leaves exactly one named
branch in this repo and never touches its working tree.

- Run one Task:
  \`crisol run --file <package> --base <ref> --name <branch> --gate "<cmd>" --adapter claude-code --json\`
  \`<package>\` is a file whose whole content is the Task. \`<ref>\` must be a local branch, tag or sha;
  \`<branch>\` must not exist yet. \`--gate\` is repeatable and replaces the Gates in
  \`.crisol/config.toml\`; leave it out to use those.
- Continue a Run by its branch:
  \`crisol run --continue <branch> --file <request> --adapter claude-code --json\`
  sends \`<request>\` to the same agent session, on the same branch, and moves that branch forward.
- Both print one JSON line, the Run result: \`branch\`, \`status\` (\`verified\`, \`unverified\`,
  \`not-converged\`, \`parked\` or \`checkpoint\`) and \`finalMessage\`, the agent's last message verbatim.
- Read \`status\`, not the exit code. A provider failure (a rate limit, a quota, a failed login) exits
  0 as \`not-converged\` with \`reason: "provider: …"\`, and a Run that failed after it started exits 1
  but still prints its Run result. Nothing on stdout means no Run result was written; stderr says why.
`;

export const LEARN_TASK =
  "This is a learn Run: Crisol records every host this Sandbox reaches. Run this repo's Gates and " +
  "whatever setup they need, and change no file.";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

const SANDBOX_HEADING_LINE = /^## Sandbox[ \t]*\r?$/m;

export type FileOutcome = "created" | "kept";

export interface InitReport {
  gates: string[];
  config: FileOutcome;
  network: FileOutcome;
  instructions: { file: string; outcome: "appended" | "created" | "already" };
}

function readScripts(hostRepoPath: string): Record<string, unknown> {
  const manifestPath = path.join(hostRepoPath, "package.json");
  if (!existsSync(manifestPath)) return {};
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON, so no Gate can be read from its scripts: ${String(error)}`);
  }
  const scripts = (manifest as { scripts?: unknown } | null)?.scripts;
  return typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>) : {};
}

/** Run with the package manager the committed lockfile names, as the Sandbox installs with it. */
export function detectGates(hostRepoPath: string): string[] {
  const scripts = readScripts(hostRepoPath);
  const manager = detectPackageManager(hostRepoPath) ?? "npm";
  return GATE_SCRIPTS.filter((name) => {
    const body = scripts[name];
    return typeof body === "string" && body.trim().length > 0 && !body.includes(NPM_PLACEHOLDER_TEST);
  }).map((name) => `${manager} run ${name}`);
}

function formatGatesLine(gates: readonly string[]): string {
  return `gates = [${gates.map((gate) => JSON.stringify(gate)).join(", ")}]\n`;
}

function writeIfAbsent(file: string, content: string): FileOutcome {
  if (existsSync(file)) return "kept";
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return "created";
}

/** Either file already carrying the block counts, so a repo whose `CLAUDE.md` links to `AGENTS.md` never gets two. */
function declareSandbox(hostRepoPath: string): InitReport["instructions"] {
  const present = INSTRUCTION_FILES.filter((name) => existsSync(path.join(hostRepoPath, name)));
  for (const name of present) {
    if (SANDBOX_HEADING_LINE.test(readFileSync(path.join(hostRepoPath, name), "utf8"))) {
      return { file: name, outcome: "already" };
    }
  }
  const file = present[0] ?? "AGENTS.md";
  const target = path.join(hostRepoPath, file);
  if (!existsSync(target)) {
    writeFileSync(target, SANDBOX_BLOCK);
    return { file, outcome: "created" };
  }
  const text = readFileSync(target, "utf8");
  const separator = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(target, `${text}${separator}${SANDBOX_BLOCK}`);
  return { file, outcome: "appended" };
}

/** Never overwrites: a file that already exists is the repo's own choice. */
export function initRepo(hostRepoPath: string): InitReport {
  const gates = detectGates(hostRepoPath);
  const config = writeIfAbsent(path.join(hostRepoPath, REPO_CONFIG_FILE), formatGatesLine(gates));
  const network = writeIfAbsent(repoAllowlistPath(hostRepoPath), "");
  const instructions = declareSandbox(hostRepoPath);
  return { gates, config, network, instructions };
}

/**
 * Unlike `crisol run --network learn`, which only prints lines to paste, this writes: the human
 * accepted the offer, and the file is left uncommitted for them to review.
 */
export function writeLearnedHosts(hostRepoPath: string, result: RunResult): string[] {
  const hosts = hostsToLearn(result.reached ?? [], learnBaseline(hostRepoPath));
  return hosts.filter((host) => addToRepoAllowlist(hostRepoPath, host).outcome === "added");
}
