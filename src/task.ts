import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readFileAtCommit } from "./git";
import { repoPromptFile, userPromptPath } from "./paths";
import { stopLine } from "./stop-line";

const TASK_VARIABLE = "{{task}}";

/** A Map, not an object literal, so a name like `constructor` never resolves to a prototype member. */
const BUILT_IN_TEMPLATES: ReadonlyMap<string, string> = new Map([
  [
    "fix-bug",
    "Fix this bug:\n\n{{task}}\n\n" +
      "First reproduce it with a failing test, then make that test pass without breaking any other.\n",
  ],
]);

/** The name becomes a path component under two directories, so it can never climb out of them. */
const TEMPLATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const PLACEHOLDER = /\{\{[^{}]*\}\}/g;

export interface Template {
  text: string;
  /** The file it came from, or `built-in`, so an error names what the user must edit. */
  source: string;
}

export interface ContextFile {
  /** As the user gave it, which is how the agent is told to refer to it. */
  path: string;
  content: string;
}

export interface TaskInput {
  task?: string;
  file?: string;
  template?: string;
  context?: readonly string[];
}

export interface ResolvedTask {
  task: string;
  context: ContextFile[];
}

/** The Template and `--context` files a fan-out's Tasks share. */
export interface ResolvedInputs {
  template?: Template;
  context: ContextFile[];
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** A binary file means nothing to the agent, so it is refused here, before anything exists. */
function readText(file: string, cwd: string, what: string): string {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path.resolve(cwd, file));
  } catch (error) {
    throw new Error(`Cannot read ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return decodeText(bytes, what);
}

function decodeText(bytes: Uint8Array, what: string): string {
  if (bytes.includes(0)) throw new Error(`${what} holds a NUL byte; only UTF-8 text can reach the agent.`);
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw new Error(`${what} is not valid UTF-8; only UTF-8 text can reach the agent.`);
  }
  if (text.trim() === "") throw new Error(`${what} is empty.`);
  return text;
}

/** Repo level beats user level beats built-in. */
export function resolveTemplate(name: string, home: string, hostRepoPath: string, baseSha: string): Template {
  if (!TEMPLATE_NAME.test(name)) {
    throw new Error(
      `--prompt "${name}" is not a template name: start with a letter or digit, then letters, digits, "-" and "_".`,
    );
  }
  const repoFile = `${repoPromptFile(name)} as committed at ${baseSha}`;
  const userFile = userPromptPath(name, home);
  const repoBytes = readFileAtCommit(hostRepoPath, baseSha, repoPromptFile(name));
  if (repoBytes !== undefined) {
    return { text: decodeText(repoBytes, `--prompt ${name} (${repoFile})`), source: repoFile };
  }
  if (existsSync(userFile)) return { text: readText(userFile, "/", `--prompt ${name} (${userFile})`), source: userFile };
  const builtIn = BUILT_IN_TEMPLATES.get(name);
  if (builtIn !== undefined) return { text: builtIn, source: "built-in" };
  throw new Error(
    `No template "${name}": not in ${repoFile}, not in ${userFile}, and not built in ` +
      `(${[...BUILT_IN_TEMPLATES.keys()].join(", ")}).`,
  );
}

/** Split and join, not `replace`, so a `$&` in the Task is never read as a replacement pattern. */
export function applyTemplate(template: Template, task: string): string {
  const others = [...new Set(template.text.match(PLACEHOLDER) ?? [])].filter((p) => p !== TASK_VARIABLE);
  if (others.length > 0) {
    const spaced = others.some((p) => p.slice(2, -2).trim() === "task") ? ` Write it as ${TASK_VARIABLE}.` : "";
    throw new Error(
      `Template ${template.source} uses ${others.join(", ")}; ${TASK_VARIABLE} is the only variable a template may use.${spaced}`,
    );
  }
  if (!template.text.includes(TASK_VARIABLE)) {
    throw new Error(`Template ${template.source} has no ${TASK_VARIABLE}, so the Task would never reach the agent.`);
  }
  return template.text.split(TASK_VARIABLE).join(task);
}

/**
 * Reads the Template and every `--context` file a fan-out's Tasks share, exactly once — a
 * one-shot path (a process substitution, a named pipe) cannot be opened again per Task.
 */
export function resolveSharedInputs(
  input: Pick<TaskInput, "template" | "context">,
  cwd: string,
  home: string,
  hostRepoPath: string,
  baseSha: string,
): ResolvedInputs {
  const template =
    input.template !== undefined ? resolveTemplate(input.template, home, hostRepoPath, baseSha) : undefined;
  const context = (input.context ?? []).map((file) => ({ path: file, content: readText(file, cwd, `--context ${file}`) }));
  return { template, context };
}

/**
 * Every user path is read here, once, in the process the user launched — or, for a fan-out's
 * shared Template and `--context` files, reused from `shared` rather than read again.
 */
export function resolveTask(
  input: TaskInput,
  cwd: string,
  home: string,
  hostRepoPath: string,
  baseSha: string,
  shared?: ResolvedInputs,
): ResolvedTask {
  if (input.file !== undefined && input.task !== undefined) {
    throw new Error("--file is the Task; it cannot be combined with a Task phrase.");
  }
  const raw = input.file !== undefined ? readText(input.file, cwd, `--file ${input.file}`) : input.task;
  if (raw === undefined) throw new Error("A Run needs a Task: a phrase or --file.");
  if (raw.trim() === "") throw new Error("Task phrase is empty.");
  const template =
    shared?.template ??
    (input.template !== undefined ? resolveTemplate(input.template, home, hostRepoPath, baseSha) : undefined);
  const task = template !== undefined ? applyTemplate(template, raw) : raw;
  const context =
    shared?.context ?? (input.context ?? []).map((file) => ({ path: file, content: readText(file, cwd, `--context ${file}`) }));
  return { task, context };
}

export function defaultPreamble(gates: readonly string[]): string {
  const verified =
    gates.length > 0
      ? `When you finish, Crisol verifies your work by running ${gates.map((gate) => `\`${gate}\``).join(", ")}; ` +
        "a failing one comes back to you to fix."
      : "No Gate is declared for this Run, so nothing verifies your work but your own Final message.";
  return [
    "You are working unattended inside a sandbox, in your own clone of the repo, on the branch already checked out.",
    verified,
    "Commit your work on that branch and do not push: Crisol collects the branch when you finish, " +
      "and only what is committed reaches it.",
    "Your last message is your Final message: Crisol hands it, verbatim, to whoever started the Run.",
    "If the network blocks something you need, say so in your Final message rather than working around it.",
    "If you stop on purpose before the work is done — parked on a decision only a human can make, or told " +
      `to checkpoint and end — make the last line of your Final message exactly \`${stopLine("parked")}\` ` +
      `or \`${stopLine("checkpoint")}\`. Crisol then runs no Gate and does not come back to you.`,
  ].join("\n");
}

/** Nothing checks an Adapter's wording but this, and a Preamble that omits a Gate misleads the agent. */
export function assertPreambleNamesGates(preamble: string, gates: readonly string[]): void {
  const missing = gates.filter((gate) => !preamble.includes(gate));
  if (missing.length > 0) {
    throw new Error(`The Adapter's Preamble does not name the Gate${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`);
  }
}

/** Tags, not Markdown headings, because a Task or a reference file brings headings of its own. */
export function buildPrompt(preamble: string, resolved: ResolvedTask): string {
  const sections = [preamble, `<task>\n${resolved.task.trim()}\n</task>`];
  if (resolved.context.length > 0) {
    sections.push("Reference material for the Task follows. It informs the Task; it is not part of it.");
    for (const file of resolved.context) {
      sections.push(`<reference file=${JSON.stringify(file.path)}>\n${file.content.trim()}\n</reference>`);
    }
  }
  return sections.join("\n\n");
}
