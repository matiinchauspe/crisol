import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Adapter, AdapterContext } from "../src/adapter";
import { DEFAULT_SCRIPT, FakeAdapter, GATE_FAILING_SCRIPT, GATE_FIXING_SCRIPT } from "../src/adapters/fake";
import { GATE_FEEDBACK_LIMIT } from "../src/gates";
import { run } from "../src/run";
import type { RunFailure, RunResult } from "../src/run";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { runCli } from "./support/cli";
import { onlyRunId, readLog, readResult } from "./support/runState";

/**
 * Fails while GATE_TARGET.txt holds "oops", passes once it holds "ok". Always PRINTS the
 * content before the check, so a red run has real stdout to carry into the resume feedback.
 */
const GATE_CMD = 'echo "content=$(cat GATE_TARGET.txt)" && [ "$(cat GATE_TARGET.txt)" = ok ]';

/** Wraps an Adapter to record every `feedback` string passed to `resumeWithFeedback`, without changing any of its behaviour. */
function recordingAdapter(inner: Adapter): { adapter: Adapter; feedbacks: string[] } {
  const feedbacks: string[] = [];
  const adapter: Adapter = {
    declarePreStart: (projectImage: string) => inner.declarePreStart(projectImage),
    launch: (ctx: AdapterContext) => inner.launch(ctx),
    reportCompletion: (ctx: AdapterContext) => inner.reportCompletion(ctx),
    async resumeWithFeedback(ctx: AdapterContext, feedback: string) {
      feedbacks.push(feedback);
      return inner.resumeWithFeedback(ctx, feedback);
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
    "an oversized red Gate resumes with a bounded tail of its output, and the Run's log keeps all of it",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const { adapter, feedbacks } = recordingAdapter(
          new FakeAdapter(GATE_FAILING_SCRIPT, GATE_FIXING_SCRIPT),
        );
        // `printf` is a builtin and brace expansion is bash's own, so the Gate needs no tool the
        // Sandbox image may lack.
        const loudGate = `printf 'error %d\\n' {1..20000} && ${GATE_CMD}`;

        const result = await run({
          task: "fix the gate",
          cwd: repo.path,
          home: home.path,
          adapter,
          gates: [loudGate],
        });

        const id = onlyRunId(home.path);
        expect(result.status).toBe("verified");
        expect(feedbacks).toHaveLength(1);
        expect(feedbacks[0]!.length).toBeLessThan(GATE_FEEDBACK_LIMIT + 1_000);
        expect(feedbacks[0]).toContain("content=oops");
        expect(feedbacks[0]).not.toContain("error 1\n");
        expect(feedbacks[0]).toContain(`crisol logs ${id}`);

        const log = readLog(id, home.path);
        expect(log).toContain("error 1\n");
        expect(log).toContain("error 20000\n");
        expect(log).toContain("content=oops");
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
        // The SAME script for launch and resume — every attempt repeats the identical
        // failing commit, so the Gate never turns green.
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
          // High enough that it can never fire; a real docker exec always takes well
          // over 10ms, so the wall clock is what actually stops this Run.
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
          ["run", "say hello", "--json", "--gate", "test -f CRISOL_RUN.md", "--adapter", "fake"],
          { cwd: repo.path, home: home.path },
        );

        expect(result.exitCode).toBe(0);
        const payload = JSON.parse(result.stdout);
        // A weaker rung (the repo's) never substitutes for the stronger one (--gate).
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

        const result = await runCli(["run", "say hello", "--json", "--adapter", "fake"], {
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

describe("ticket 20: the Final message and the Stop line", () => {
  /** Blank lines, Markdown and a trailing newline: anything Crisol trimmed or reshaped would show. */
  const REPORT = "Done.\n\n- criterion 1: covered by `bun test`\n- HOW default: kept the old name\n";

  test(
    "a Final message without a Stop line lands verbatim in the Run result and result.json on verified",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({
          task: "say hello",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(DEFAULT_SCRIPT, undefined, undefined, { launch: REPORT }),
          gates: ["test -f CRISOL_RUN.md"],
        });

        expect(result.status).toBe("verified");
        expect(result.finalMessage).toBe(REPORT);
        expect(readResult(onlyRunId(home.path), home.path)?.finalMessage).toBe(REPORT);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "on not-converged the Final message is the last iteration's, not the first",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({
          task: "never fix the gate",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(GATE_FAILING_SCRIPT, GATE_FAILING_SCRIPT, undefined, {
            launch: "first attempt",
            resume: REPORT,
          }),
          gates: [GATE_CMD],
          maxIterations: 2,
          ceilingMs: 10 * 60 * 1000,
        });

        expect(result.status).toBe("not-converged");
        expect(result.reason).toBe("ceiling");
        expect(result.finalMessage).toBe(REPORT);
        expect(readResult(onlyRunId(home.path), home.path)?.finalMessage).toBe(REPORT);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "a resume turn that throws leaves the Final message empty, not the earlier successful turn's",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        let outcome: RunResult | undefined;
        try {
          outcome = await run({
            task: "throw on resume",
            cwd: repo.path,
            home: home.path,
            adapter: new FakeAdapter(GATE_FAILING_SCRIPT, undefined, undefined, { launch: "first attempt" }),
            gates: [GATE_CMD],
          });
        } catch (error) {
          outcome = (error as RunFailure).result;
        }

        expect(outcome?.status).toBe("not-converged");
        expect(outcome?.reason).toContain("no resumeScript");
        expect(outcome?.finalMessage).toBeUndefined();
        expect(readResult(onlyRunId(home.path), home.path)?.finalMessage).toBeUndefined();
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  for (const reason of ["parked", "checkpoint"] as const) {
    test(
      `a Stop line naming ${reason}, over a failing Gate, ends the Run ${reason}: no Gate runs and the session is never resumed`,
      async () => {
        const home = createTempHome();
        const repo = createFixtureRepo();
        try {
          const message = `Stopping here.\n\nQuestion: which name wins?\n\nCRISOL-STOP: ${reason}\n`;
          // No resume script: a resume would throw and turn the Run not-converged.
          const { adapter, feedbacks } = recordingAdapter(
            new FakeAdapter(GATE_FAILING_SCRIPT, undefined, undefined, { launch: message }),
          );

          const result = await run({
            task: "stop on purpose",
            cwd: repo.path,
            home: home.path,
            adapter,
            gates: [GATE_CMD],
          });

          expect(result.status).toBe(reason);
          expect(result.reason).toBeUndefined();
          expect(result.iterations).toBe(1);
          expect(result.gates).toEqual([]);
          expect(result.finalMessage).toBe(message);
          expect(feedbacks).toHaveLength(0);
          const id = onlyRunId(home.path);
          expect(readResult(id, home.path)?.status).toBe(reason);
          expect(readLog(id, home.path)).not.toContain("gates (iteration");
        } finally {
          home.cleanup();
          repo.cleanup();
        }
      },
      60_000,
    );
  }

  test(
    "a Stop line after a resume ends the Run there, without another Gate pass or resume",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const { adapter, feedbacks } = recordingAdapter(
          new FakeAdapter(GATE_FAILING_SCRIPT, GATE_FAILING_SCRIPT, undefined, {
            launch: "first attempt",
            resume: "Cannot fix this without a decision.\nCRISOL-STOP: parked",
          }),
        );

        const result = await run({
          task: "stop after one red Gate",
          cwd: repo.path,
          home: home.path,
          adapter,
          gates: [GATE_CMD],
          maxIterations: 5,
          ceilingMs: 10 * 60 * 1000,
        });

        expect(result.status).toBe("parked");
        expect(result.iterations).toBe(2);
        expect(feedbacks).toHaveLength(1);
        const gatePasses = readLog(onlyRunId(home.path), home.path).match(/gates \(iteration/g) ?? [];
        expect(gatePasses).toHaveLength(1);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "with no Gate declared, a Stop line still ends the Run parked rather than unverified",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({
          task: "stop on purpose",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(DEFAULT_SCRIPT, undefined, undefined, { launch: "Need a decision.\nCRISOL-STOP: parked" }),
        });

        expect(result.status).toBe("parked");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "a Stop line anywhere but the last line, or naming an unknown reason, is not a stop: the Gates still run",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        for (const message of ["CRISOL-STOP: parked\nthen I carried on and finished.", "CRISOL-STOP: bored"]) {
          const result = await run({
            task: "say hello",
            cwd: repo.path,
            home: home.path,
            adapter: new FakeAdapter(DEFAULT_SCRIPT, undefined, undefined, { launch: message }),
            gates: ["test -f CRISOL_RUN.md"],
          });

          expect(result.status).toBe("verified");
          expect(result.gates).toEqual([{ cmd: "test -f CRISOL_RUN.md", ok: true }]);
          expect(result.finalMessage).toBe(message);
        }
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    120_000,
  );
});
