import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Adapter } from "../src/adapter";
import { runPromptPath } from "../src/paths";
import { run, runFanOut } from "../src/run";
import type { RunOptions } from "../src/run";
import { resolveTask, resolveTemplate } from "../src/task";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { waitFor } from "./support/liveCli";
import { onlyRunId, readResult, runIds, stopRuns } from "./support/runState";

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");

function silentAdapter(launch: Adapter["launch"], preamble?: Adapter["preamble"]): Adapter {
  return {
    declarePreStart() {
      return { envNames: [], mounts: [] };
    },
    preamble,
    launch,
    async reportCompletion() {
      return true;
    },
    async resumeWithFeedback() {},
  };
}

async function promptFor(options: Omit<RunOptions, "adapter">, preamble?: Adapter["preamble"]): Promise<string> {
  let seen: string | undefined;
  await run({
    ...options,
    adapter: silentAdapter(async (ctx) => {
      seen = ctx.prompt;
    }, preamble),
  });
  if (seen === undefined) throw new Error("the Adapter was never launched");
  return seen;
}

function writeTemplate(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.md`), text);
}

function savedPrompt(home: string): string {
  return readFileSync(runPromptPath(onlyRunId(home), home), "utf8");
}

describe("--file (ticket 10)", () => {
  test("the file's content is the Task the agent receives, and the run dir keeps that prompt", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const content = "# Ticket\n\nRename `foo` to `bar` everywhere.";
      writeFileSync(path.join(repo.path, "ticket.md"), `${content}\n`);

      const prompt = await promptFor({ file: "ticket.md", cwd: repo.path, home: home.path });

      expect(prompt).toContain(`<task>\n${content}\n</task>`);
      expect(savedPrompt(home.path)).toBe(prompt);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("from the CLI, the file's content reaches the prompt", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "ticket.md"), "Rename foo to bar.\n");

      const result = await runCli(["run", "--file", "ticket.md", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });

      expect(result.exitCode).toBe(0);
      expect(savedPrompt(home.path)).toContain("<task>\nRename foo to bar.\n</task>");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a phrase beside --file, a missing file, or an empty one fails before anything happens", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "ticket.md"), "do it\n");
      writeFileSync(path.join(repo.path, "empty.md"), "\n");

      const both = await runCli(["run", "a phrase", "--file", "ticket.md"], { cwd: repo.path, home: home.path });
      const missing = await runCli(["run", "--file", "nope.md", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      const empty = await runCli(["run", "--file", "empty.md", "--adapter", "fake"], { cwd: repo.path, home: home.path });

      expect(both.exitCode).toBe(1);
      expect(both.stderr).toContain("--file");
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("nope.md");
      expect(empty.exitCode).toBe(1);
      expect(empty.stderr).toContain("empty.md is empty");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("a blank Task phrase fails before anything happens, like an empty --file (ticket 10, round 2)", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const blank = await runCli(["run", "", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      const whitespace = await runCli(["run", "   ", "--adapter", "fake"], { cwd: repo.path, home: home.path });

      expect(blank.exitCode).toBe(1);
      expect(blank.stderr).toContain("Task phrase is empty");
      expect(whitespace.exitCode).toBe(1);
      expect(whitespace.stderr).toContain("Task phrase is empty");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("--context (ticket 10)", () => {
  test("each file reaches the agent in its own reference section, after the Task", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "spec.md"), "# Spec\n\nThe spec body.\n");
      mkdirSync(path.join(repo.path, "docs"));
      writeFileSync(path.join(repo.path, "docs", "glossary.md"), "Run: one Task.\n");

      const prompt = await promptFor({
        task: "implement the spec",
        context: ["spec.md", "docs/glossary.md"],
        cwd: repo.path,
        home: home.path,
      });

      const task = prompt.indexOf("<task>\nimplement the spec\n</task>");
      const spec = prompt.indexOf('<reference file="spec.md">\n# Spec\n\nThe spec body.\n</reference>');
      const glossary = prompt.indexOf('<reference file="docs/glossary.md">\nRun: one Task.\n</reference>');
      expect(task).toBeGreaterThan(-1);
      expect(spec).toBeGreaterThan(task);
      expect(glossary).toBeGreaterThan(spec);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("from the CLI, a context file reaches the prompt; a missing or empty one fails before anything happens", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "spec.md"), "The spec body.\n");
      writeFileSync(path.join(repo.path, "empty.md"), "");

      const missing = await runCli(["run", "x", "--context", "nope.md", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      const empty = await runCli(["run", "x", "--context", "empty.md", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("--context nope.md");
      expect(empty.exitCode).toBe(1);
      expect(empty.stderr).toContain("--context empty.md is empty");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);

      const ok = await runCli(["run", "x", "--context", "spec.md", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      expect(ok.exitCode).toBe(0);
      expect(savedPrompt(home.path)).toContain('<reference file="spec.md">\nThe spec body.\n</reference>');
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a binary or non-UTF-8 file fails before anything happens, without echoing its bytes", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "doc.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x53, 0x45, 0x43, 0x52, 0x45, 0x54]));
      writeFileSync(path.join(repo.path, "latin1.md"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));

      const binary = await runCli(["run", "x", "--context", "doc.pdf", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      const latin1 = await runCli(["run", "--file", "latin1.md", "--adapter", "fake"], { cwd: repo.path, home: home.path });

      expect(binary.exitCode).toBe(1);
      expect(binary.stderr).toContain("--context doc.pdf holds a NUL byte");
      expect(binary.stderr).not.toContain("SECRET");
      expect(latin1.exitCode).toBe(1);
      expect(latin1.stderr).toContain("--file latin1.md is not valid UTF-8");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("a prompt past Linux's 128 KiB argv string cap reaches the Sandbox intact over stdin", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "big.md"), `${"0123456789abcdef".repeat(200 * 64)}\n`);
      let sent = "";
      let received = "";

      await run({
        task: "read the reference",
        context: ["big.md"],
        cwd: repo.path,
        home: home.path,
        adapter: silentAdapter(async (ctx) => {
          sent = ctx.prompt;
          received = (await ctx.sandbox.exec(["sha256sum"], ctx.prompt)).stdout.split(" ")[0]!;
        }),
      });

      expect(Buffer.byteLength(sent)).toBeGreaterThan(200 * 1024);
      expect(received).toBe(new Bun.CryptoHasher("sha256").update(sent).digest("hex"));
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);
});

describe("--detach resolves the text once, in the process the user launched (ticket 10)", () => {
  test("a --file that only the launching process can read still reaches the agent", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const detached = Bun.spawnSync(
        ["bash", "-c", `bun run "${CLI_ENTRY}" run --detach --file <(printf 'from a pipe') --adapter fake`],
        { cwd: repo.path, env: { ...process.env, CRISOL_HOME: home.path }, stdout: "pipe", stderr: "pipe" },
      );
      expect(detached.exitCode).toBe(0);
      const id = detached.stdout.toString("utf8").trim();

      await waitFor(() => readResult(id, home.path) !== undefined, 90_000);
      expect(readResult(id, home.path)!.status).toBe("unverified");
      expect(readFileSync(runPromptPath(id, home.path), "utf8")).toContain("<task>\nfrom a pipe\n</task>");
    } finally {
      await stopRuns(home.path);
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);

  test("deleting a context file right after detaching does not fail the Run", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const contextFile = path.join(repo.path, "tmp-context.md");
      writeFileSync(contextFile, "temporary context\n");

      const detached = await runCli(["run", "x", "--detach", "--context", contextFile, "--adapter", "fake"], {
        cwd: repo.path,
        home: home.path,
      });
      rmSync(contextFile);
      expect(detached.exitCode).toBe(0);
      const id = detached.stdout.trim();

      await waitFor(() => readResult(id, home.path) !== undefined, 90_000);
      expect(readResult(id, home.path)!.status).toBe("unverified");
      expect(readFileSync(runPromptPath(id, home.path), "utf8")).toContain("temporary context");
    } finally {
      await stopRuns(home.path);
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);
});

describe("--prompt templates (ticket 10)", () => {
  test("repo level beats user level beats built-in", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      expect(resolveTemplate("fix-bug", home.path, repo.path).source).toBe("built-in");
      writeTemplate(path.join(home.path, "prompts"), "fix-bug", "USER LEVEL: {{task}}");
      expect(resolveTemplate("fix-bug", home.path, repo.path).text).toBe("USER LEVEL: {{task}}");
      writeTemplate(path.join(repo.path, ".crisol", "prompts"), "fix-bug", "REPO LEVEL: {{task}}");
      expect(resolveTemplate("fix-bug", home.path, repo.path).text).toBe("REPO LEVEL: {{task}}");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("the Task fills {{task}} verbatim in the prompt the agent receives", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const task = "emails with a + fail; keep $& and $1 as typed";

      const prompt = await promptFor({ task, template: "fix-bug", cwd: repo.path, home: home.path });

      expect(prompt).toContain(`<task>\nFix this bug:\n\n${task}\n\nFirst reproduce it`);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("--file together with --prompt applies the template to the file's content (ticket 10, round 2)", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "ticket.md"), "Rename foo to bar.\n");

      const prompt = await promptFor({ file: "ticket.md", template: "fix-bug", cwd: repo.path, home: home.path });

      // The file's own trailing newline survives substitution, same as any other Task text would.
      expect(prompt).toContain("<task>\nFix this bug:\n\nRename foo to bar.\n\n\nFirst reproduce it");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("a placeholder other than {{task}} fails before launch, naming it", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const prompts = path.join(repo.path, ".crisol", "prompts");
      writeTemplate(prompts, "ticket", "Ticket {{ticket}}: {{task}}");
      writeTemplate(prompts, "spaced", "{{ task }}");

      const result = await runCli(["run", "x", "--prompt", "ticket", "--adapter", "fake"], { cwd: repo.path, home: home.path });
      const spaced = await runCli(["run", "x", "--prompt", "spaced", "--adapter", "fake"], { cwd: repo.path, home: home.path });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("{{ticket}}");
      expect(spaced.exitCode).toBe(1);
      expect(spaced.stderr).toContain("Write it as {{task}}");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("a template without {{task}}, a bad or unknown name, an unreadable one or a second --prompt fails before launch", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const prompts = path.join(repo.path, ".crisol", "prompts");
      writeTemplate(prompts, "static", "Do something else.");
      mkdirSync(path.join(prompts, "folder.md"));
      writeFileSync(path.join(repo.path, "escape.md"), "{{task}}");
      const cli = (...args: string[]) => runCli(["run", "x", ...args, "--adapter", "fake"], { cwd: repo.path, home: home.path });

      const noTask = await cli("--prompt", "static");
      const climbing = await cli("--prompt", "../../escape");
      const unknown = await cli("--prompt", "nope");
      const folder = await cli("--prompt", "folder");
      const twice = await cli("--prompt", "fix-bug", "--prompt", "static");

      expect(noTask.stderr).toContain("{{task}}");
      expect(climbing.stderr).toContain("not a template name");
      expect(unknown.stderr).toContain('No template "nope"');
      expect(folder.stderr).toContain("Cannot read --prompt folder");
      expect(twice.stderr).toContain("--prompt names one template");
      for (const result of [noTask, climbing, unknown, folder, twice]) expect(result.exitCode).toBe(1);
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("the Preamble (ticket 10)", () => {
  test("comes before the Task, names the Run's actual Gates, and states the sandbox's rules", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      mkdirSync(path.join(repo.path, ".crisol"));
      writeFileSync(path.join(repo.path, ".crisol", "config.toml"), 'gates = ["test -f README.md"]\n');

      const repoGates = await promptFor({ task: "do it", cwd: repo.path, home: home.path });
      const cliGates = await promptFor({ task: "do it", gates: ["true", "test -d ."], cwd: repo.path, home: home.path });

      const preamble = repoGates.slice(0, repoGates.indexOf("<task>"));
      expect(preamble).toContain("`test -f README.md`");
      expect(preamble).toContain("do not push");
      expect(preamble).toContain("If the network blocks something you need, say so");
      expect(cliGates).toContain("`true`, `test -d .`");
      expect(cliGates).not.toContain("test -f README.md");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);

  test("teaches the Final message and the Stop line for both reasons, and still names every Gate (ticket 20)", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const prompt = await promptFor({ task: "do it", gates: ["true", "bun test"], cwd: repo.path, home: home.path });

      const preamble = prompt.slice(0, prompt.indexOf("<task>"));
      expect(preamble).toContain("`true`, `bun test`");
      expect(preamble).toContain("Final message");
      expect(preamble).not.toContain("final report");
      expect(preamble).toContain("`CRISOL-STOP: parked`");
      expect(preamble).toContain("`CRISOL-STOP: checkpoint`");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("an Adapter's own wording replaces the default", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const prompt = await promptFor(
        { task: "do it", gates: ["true"], cwd: repo.path, home: home.path },
        (gates) => `TUNED for ${gates.join(" and ")}`,
      );

      expect(prompt.startsWith("TUNED for true\n\n<task>\ndo it\n</task>")).toBe(true);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 60_000);

  test("an Adapter's wording that leaves out a Gate fails before launch", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const attempt = promptFor(
        { task: "do it", gates: ["true", "bun test"], cwd: repo.path, home: home.path },
        () => "Verified by `true`.",
      );

      await expect(attempt).rejects.toThrow("does not name the Gate bun test");
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("fan-out shares its inputs safely (ticket 10, round 2)", () => {
  test("resolveTask refuses file and a Task phrase together, even below the CLI", () => {
    expect(() => resolveTask({ file: "ticket.md", task: "a phrase" }, "/", "/home", "/repo")).toThrow(
      "cannot be combined with a Task phrase",
    );
  });

  test("runFanOut refuses file and a Task phrase together, for every Task, for a caller that bypasses the CLI's own guard", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(repo.path, "ticket.md"), "do it\n");

      // Typed as RunOptions, not runFanOut's narrower parameter type, the way a caller who
      // skips the CLI could still construct it.
      const illegalOptions: Omit<RunOptions, "task" | "name" | "baseSha"> = {
        file: "ticket.md",
        cwd: repo.path,
        home: home.path,
      };
      const settled = await runFanOut(["a", "b"], illegalOptions);

      expect(settled).toHaveLength(2);
      for (const outcome of settled) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") {
          expect(String((outcome.reason as Error).message)).toContain("cannot be combined with a Task phrase");
        }
      }
      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("a piped --context and a one-shot --prompt template are each read exactly once, not once per Task", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      const promptsDir = path.join(repo.path, ".crisol", "prompts");
      mkdirSync(promptsDir, { recursive: true });
      const templateFifo = path.join(promptsDir, "once.md");
      const mkfifo = Bun.spawnSync(["mkfifo", templateFifo]);
      if (mkfifo.exitCode !== 0) throw new Error(`mkfifo failed: ${mkfifo.stderr.toString("utf8")}`);

      // A background writer feeds the Template's one-shot pipe exactly once; `--context`'s process
      // substitution is its own one-shot pipe. A second read of either, from a second Task's Run,
      // would fail (the pipe is drained) or hang (the FIFO has no writer left).
      const script =
        `(printf 'Do: {{task}}\\n' > "${templateFifo}" &) ; ` +
        `bun run "${CLI_ENTRY}" run "task one" "task two" --context <(printf 'spec body') --prompt once --json --adapter fake`;

      const proc = Bun.spawnSync(["bash", "-c", script], {
        cwd: repo.path,
        env: { ...process.env, CRISOL_HOME: home.path },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(proc.stderr.toString("utf8")).toBe("");
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString("utf8").trim().split("\n")).toHaveLength(2);

      const ids = runIds(home.path);
      expect(ids).toHaveLength(2);
      const prompts = ids.map((id) => readFileSync(runPromptPath(id, home.path), "utf8"));
      expect(prompts.some((prompt) => prompt.includes("<task>\nDo: task one"))).toBe(true);
      expect(prompts.some((prompt) => prompt.includes("<task>\nDo: task two"))).toBe(true);
      for (const prompt of prompts) expect(prompt).toContain("spec body");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);
});
