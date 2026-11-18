import path from "node:path";

const CLI_ENTRY = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the CLI as a real, separate process: tests observe only what it prints and
 * what it leaves on disk, never its internals. Runs the TypeScript entrypoint
 * directly, not a `bun build --compile` binary, so the suite stays fast.
 *
 * `stdin`, when given, answers a prompt (`crisol gc`'s confirmation); omitted, the process gets
 * no stdin, which reads as an immediate EOF — the same as a script piping nothing in.
 */
export async function runCli(
  args: string[],
  options: { cwd: string; home?: string; env?: Record<string, string>; stdin?: string },
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: { ...process.env, CRISOL_HOME: options.home ?? "", ...options.env },
    stdin: options.stdin !== undefined ? "pipe" : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (options.stdin !== undefined && proc.stdin !== undefined && typeof proc.stdin !== "number") {
    proc.stdin.write(options.stdin);
    await proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}
