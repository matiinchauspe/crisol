import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * - `stall`: sleep `seconds` before running the real command, so a test can land a signal
 *   while it is in flight.
 * - `fail-once`: exit 1 the first time, run the real command afterwards.
 * - `fail-always`: exit 1 every time.
 */
export type WrapMode = { kind: "stall"; seconds: number } | { kind: "fail-once" } | { kind: "fail-always" };

export interface WrapRule {
  tool: "git" | "docker";
  /** Matched against each argument exactly: `clone`, `fetch`, `run`, `rm`. */
  subcommand: string;
  mode: WrapMode;
}

export interface WrappedTools {
  /** Prepend to the `PATH` handed to `crisol`. */
  binDir: string;
  /** One line per invocation that matched `subcommand`, holding the wrapper's own pid. */
  hits(tool: "git" | "docker", subcommand: string): number[];
  cleanup(): void;
}

function behaviour(mode: WrapMode, hitFile: string): string {
  switch (mode.kind) {
    case "stall":
      return `echo $$ >> "${hitFile}"; sleep ${mode.seconds}`;
    case "fail-once":
      return `if [ ! -s "${hitFile}" ]; then echo $$ >> "${hitFile}"; echo "wrapped failure" >&2; exit 1; fi`;
    case "fail-always":
      return `echo $$ >> "${hitFile}"; echo "wrapped failure" >&2; exit 1`;
  }
}

/**
 * Shell wrappers standing in for `git` and `docker` on `PATH`: the outside tools are the
 * only place a test can make a step slow or failing on demand. Every other invocation
 * runs the real binary untouched.
 */
export function wrapTools(rules: readonly WrapRule[]): WrappedTools {
  const binDir = mkdtempSync(path.join(tmpdir(), "crisol-wrapped-bin-"));
  const hitPath = (tool: string, subcommand: string) => path.join(binDir, `${tool}-${subcommand}.hits`);

  for (const tool of ["git", "docker"] as const) {
    const toolRules = rules.filter((rule) => rule.tool === tool);
    if (toolRules.length === 0) continue;
    const real = Bun.which(tool);
    if (!real) throw new Error(`${tool} not found on PATH`);
    const cases = toolRules
      .map((rule) => `    ${rule.subcommand}) ${behaviour(rule.mode, hitPath(tool, rule.subcommand))}; break ;;`)
      .join("\n");
    const script = `#!/bin/sh\nfor arg in "$@"; do\n  case "$arg" in\n${cases}\n  esac\ndone\nexec "${real}" "$@"\n`;
    const wrapper = path.join(binDir, tool);
    writeFileSync(wrapper, script);
    chmodSync(wrapper, 0o755);
  }

  return {
    binDir,
    hits(tool, subcommand) {
      const file = hitPath(tool, subcommand);
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
    },
    cleanup() {
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}
