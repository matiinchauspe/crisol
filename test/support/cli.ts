import path from "node:path";

const CLI_ENTRY = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the `crisol` CLI as a real, separate process — the spec's own
 * Testing Decisions name the CLI itself as the one seam: tests observe
 * only what it prints and what it leaves on disk, never its internals.
 * Mirrors Tenaza's own `test/support/cli.ts` `runCli` helper. Runs the
 * TypeScript entrypoint directly (not a `bun build --compile` binary) so
 * the suite stays fast; building the binary is this ticket's own
 * `package.json` `build` script, never run by the suite.
 */
export async function runCli(
  args: string[],
  options: { cwd: string; home?: string; env?: Record<string, string> },
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: { ...process.env, CRISOL_HOME: options.home ?? "", ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}
