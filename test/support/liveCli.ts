import path from "node:path";

const CLI_ENTRY = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

export interface LiveCli {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  stderr(): string;
  finished(): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

/**
 * A `crisol` process the test can watch and signal while it runs. It leads its own process
 * group, so `process.kill(-pid, …)` reaches it and every child it did not detach — what a
 * terminal does on Ctrl+C or hang-up — without reaching the test runner.
 */
export function startCli(
  args: string[],
  options: { cwd: string; home: string; env?: Record<string, string> },
): LiveCli {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: { ...process.env, CRISOL_HOME: options.home, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let stderr = "";
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) stderr += decoder.decode(chunk);
  })();
  const stdout = new Response(proc.stdout).text();
  return {
    proc,
    stderr: () => stderr,
    async finished() {
      const exitCode = await proc.exited;
      await stderrDone;
      return { exitCode, stdout: await stdout, stderr };
    },
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await Bun.sleep(50);
  }
}
