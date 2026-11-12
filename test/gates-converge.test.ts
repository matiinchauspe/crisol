import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Adapter, AdapterContext } from "../src/adapter";
import { FakeAdapter, GATE_FAILING_SCRIPT, GATE_FIXING_SCRIPT } from "../src/adapters/fake";
import { run } from "../src/run";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { runCli } from "./support/cli";

/**
 * A Gate that fails while `GATE_TARGET.txt` holds "oops" (what
 * `GATE_FAILING_SCRIPT` leaves it at) and passes once it holds "ok" (what
 * `GATE_FIXING_SCRIPT` leaves it at). Always PRINTS the file's content
 * before the pass/fail check, so a red run always has real stdout to
 * carry into the resume feedback.
 */
const GATE_CMD = 'echo "content=$(cat GATE_TARGET.txt)" && [ "$(cat GATE_TARGET.txt)" = ok ]';

/** Wraps an Adapter to record every `feedback` string passed to `resumeWithFeedback`, without changing any of its behaviour. */
function recordingAdapter(inner: Adapter): { adapter: Adapter; feedbacks: string[] } {
  const feedbacks: string[] = [];
  const adapter: Adapter = {
    declarePreStart: () => inner.declarePreStart(),
    launch: (ctx: AdapterContext) => inner.launch(ctx),
    reportCompletion: (ctx: AdapterContext) => inner.reportCompletion(ctx),
    async resumeWithFeedback(ctx: AdapterContext, feedback: string) {
      feedbacks.push(feedback);
      await inner.resumeWithFeedback(ctx, feedback);
    },
  };
  return { adapter, feedbacks };
}

describe("ticket 02: Gates and converge", () => {
  test(
    'Fake Adapter "succeed at once" + a passing Gate -> verified, iterations: 1',
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({
          task: "say hello",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(),
          gates: ["test -f CRISOL_RUN.md"],
        });

        expect(result.status).toBe("verified");
        expect(result.iterations).toBe(1);
        expect(result.reason).toBeUndefined();
        // Every result lists each Gate as { cmd, ok }.
        expect(result.gates).toEqual([{ cmd: "test -f CRISOL_RUN.md", ok: true }]);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    'Fake Adapter "fail then fix on resume" -> verified, iterations: 2, and the resume message carried the failing command and output',
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const { adapter, feedbacks } = recordingAdapter(
          new FakeAdapter(GATE_FAILING_SCRIPT, GATE_FIXING_SCRIPT),
        );

        const result = await run({
          task: "fix the gate",
          cwd: repo.path,
          home: home.path,
          adapter,
          gates: [GATE_CMD],
        });

        expect(result.status).toBe("verified");
        expect(result.iterations).toBe(2);
        expect(result.gates).toEqual([{ cmd: GATE_CMD, ok: true }]);

        // The resume message carried the failing command and its output.
        expect(feedbacks).toHaveLength(1);
        expect(feedbacks[0]).toContain(GATE_CMD);
        expect(feedbacks[0]).toContain("content=oops");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    'Fake Adapter "never converge" -> not-converged, reason: ceiling, after exactly the configured iterations',
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        // The SAME script for launch and resume: every attempt repeats the
        // identical failing commit, so the Gate stays red forever.
        const adapter = new FakeAdapter(GATE_FAILING_SCRIPT, GATE_FAILING_SCRIPT);

        const result = await run({
          task: "never fix the gate",
          cwd: repo.path,
          home: home.path,
          adapter,
          gates: [GATE_CMD],
          maxIterations: 3,
          ceilingMs: 10 * 60 * 1000, // large enough that only the iteration ceiling can fire
        });

        expect(result.status).toBe("not-converged");
        expect(result.reason).toBe("ceiling");
        expect(result.iterations).toBe(3);
        expect(result.gates).toEqual([{ cmd: GATE_CMD, ok: false }]);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "a wall-clock ceiling stops a Run and reports reason: ceiling",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const adapter = new FakeAdapter(GATE_FAILING_SCRIPT, GATE_FAILING_SCRIPT);

        const result = await run({
          task: "never fix the gate, slowly",
          cwd: repo.path,
          home: home.path,
          adapter,
          gates: [GATE_CMD],
          // An iteration ceiling high enough that it can never be the one
          // that fires; a real docker exec always takes well over 10ms, so
          // the wall clock is what actually stops this Run.
          maxIterations: 1000,
          ceilingMs: 10,
        });

        expect(result.status).toBe("not-converged");
        expect(result.reason).toBe("ceiling");
        // Proves the ITERATION ceiling (1000) was nowhere close to firing.
        expect(result.iterations).toBeLessThan(10);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "--gate present on the CLI makes the repo's own .crisol/config.toml Gates ignored entirely",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        // The repo declares a Gate that would fail if it were ever run.
        mkdirSync(path.join(repo.path, ".crisol"));
        writeFileSync(
          path.join(repo.path, ".crisol", "config.toml"),
          'gates = ["exit 1"]\n',
        );

        const result = await runCli(
          ["run", "say hello", "--json", "--gate", "test -f CRISOL_RUN.md"],
          { cwd: repo.path, home: home.path },
        );

        expect(result.exitCode).toBe(0);
        const payload = JSON.parse(result.stdout);
        // A weaker rung (the repo's) never substitutes for the stronger one
        // (--gate): the result must show ONLY the CLI's own Gate, green.
        expect(payload.status).toBe("verified");
        expect(payload.gates).toEqual([{ cmd: "test -f CRISOL_RUN.md", ok: true }]);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "no Gate anywhere in the ladder -> unverified",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({
          task: "say hello",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(),
        });

        expect(result.status).toBe("unverified");
        expect(result.iterations).toBe(1);
        expect(result.gates).toEqual([]);
        expect(result.reason).toBeUndefined();
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "~/.crisol/config's max_iterations makes the 'never converge' Run stop at exactly that many iterations",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        writeFileSync(path.join(home.path, "config"), "max_iterations = 2\n");
        const adapter = new FakeAdapter(GATE_FAILING_SCRIPT, GATE_FAILING_SCRIPT);

        const result = await run({
          task: "never fix the gate",
          cwd: repo.path,
          home: home.path,
          adapter,
          gates: [GATE_CMD],
          // Large enough that only the configured ITERATION ceiling can fire —
          // same isolation as the plain "never converge" scenario above.
          ceilingMs: 10 * 60 * 1000,
        });

        expect(result.status).toBe("not-converged");
        expect(result.reason).toBe("ceiling");
        expect(result.iterations).toBe(2);
        expect(result.gates).toEqual([{ cmd: GATE_CMD, ok: false }]);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "the repo's own .crisol/config.toml Gates are used when no --gate is passed",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        mkdirSync(path.join(repo.path, ".crisol"));
        writeFileSync(
          path.join(repo.path, ".crisol", "config.toml"),
          'gates = ["test -f CRISOL_RUN.md"]\n',
        );

        const result = await runCli(["run", "say hello", "--json"], {
          cwd: repo.path,
          home: home.path,
        });

        expect(result.exitCode).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload.status).toBe("verified");
        expect(payload.gates).toEqual([{ cmd: "test -f CRISOL_RUN.md", ok: true }]);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );
});
