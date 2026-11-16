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

/** `-f` fails the step on anything short of a 2xx, so the script's own exit code is the assertion. */
export const REACH_ALLOWED_HOST_SCRIPT: readonly string[] = [
  "curl -fsS --max-time 20 https://registry.npmjs.org/ > /dev/null",
  "echo 'reached an allowlisted host' > ALLOWED.txt",
  "git add ALLOWED.txt",
  "git commit --quiet -m 'test: reach an allowlisted host'",
];

/** Twice, so `count: 2` tells a real block from a coincidence; the refusal is expected, hence `|| true`. */
export const REACH_BLOCKED_HOST_SCRIPT: readonly string[] = [
  "curl -sS --max-time 20 -o /dev/null https://example.com/ || true",
  "curl -sS --max-time 20 -o /dev/null https://example.com/ || true",
  "echo 'attempted a blocked host twice' > BLOCKED.txt",
  "git add BLOCKED.txt",
  "git commit --quiet -m 'test: attempt a blocked host'",
];

/**
 * The committed file is how a test outside the Sandbox learns whether egress around the proxy got
 * out. The IP literal needs no DNS, so its failure proves there is no route, not just no resolver.
 */
export const DIRECT_EGRESS_SCRIPT: readonly string[] = [
  "curl -sS --noproxy '*' --max-time 15 https://registry.npmjs.org/ > /dev/null 2>&1 " +
    "&& echo 'hostname REACHED' > DIRECT.txt || echo 'hostname BLOCKED' > DIRECT.txt",
  "curl -sS --noproxy '*' --max-time 15 http://1.1.1.1/ > /dev/null 2>&1 " +
    "&& echo 'ip-literal REACHED' >> DIRECT.txt || echo 'ip-literal BLOCKED' >> DIRECT.txt",
  "git add DIRECT.txt",
  "git commit --quiet -m 'test: direct egress bypassing the proxy'",
];

/**
 * An allowlisted host on a port the wall never opens, once as plain HTTP and once as a CONNECT
 * tunnel. Only a refusal answers 403; a proxy that let it through reaches port 22's SSH banner
 * and answers 503. A refused tunnel's status is `http_connect`, not `http_code`.
 */
export const REACH_ALLOWED_HOST_ON_ANOTHER_PORT_SCRIPT: readonly string[] = [
  "curl -sS --max-time 20 -o /dev/null -w '%{http_code}\\n' http://github.com:22/ > PORT.txt || true",
  "curl -sS --max-time 20 -o /dev/null -w '%{http_connect}\\n' -p http://github.com:22/ >> PORT.txt || true",
  "git add PORT.txt",
  "git commit --quiet -m 'test: reach an allowlisted host on another port'",
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
