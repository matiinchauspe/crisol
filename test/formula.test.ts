import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_FORMULA = path.join(import.meta.dir, "..", "Formula", "crisol.rb");
const SCRIPT = path.join(import.meta.dir, "..", "scripts", "formula.ts");

const BOTH = { "crisol-darwin-arm64": "arm64 build", "crisol-darwin-x64": "x64 build" };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "crisol-formula-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(cmd: string[], cwd = dir) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

// The same command release.yml runs in dist/, so the file is byte-for-byte what the workflow hands the script.
async function shasumChecksums(
  binaries: Record<string, string>,
): Promise<{ file: string; sums: Record<string, string> }> {
  for (const [name, content] of Object.entries(binaries)) writeFileSync(path.join(dir, name), content);
  const { stdout, exitCode } = await run(["shasum", "-a", "256", ...Object.keys(binaries)]);
  expect(exitCode).toBe(0);
  const file = path.join(dir, "checksums.txt");
  writeFileSync(file, stdout);
  const sums: Record<string, string> = {};
  for (const line of stdout.trim().split("\n")) {
    const [sum, name] = line.split(/\s+/);
    sums[name!] = sum!;
  }
  return { file, sums };
}

function copyRepoFormula(): string {
  const target = path.join(dir, "crisol.rb");
  writeFileSync(target, readFileSync(REPO_FORMULA, "utf8"));
  return target;
}

function shaAfterUrl(formula: string, binary: string): string | undefined {
  const match = formula.match(new RegExp(`/${binary}"\\s*\\n\\s*sha256 "([^"]*)"`));
  return match?.[1];
}

describe("the release's formula script", () => {
  test("fill writes the version and each binary's sha256 from shasum's checksums.txt under that binary's url", async () => {
    const formula = copyRepoFormula();
    const { file, sums } = await shasumChecksums(BOTH);

    const result = await run(["bun", SCRIPT, "fill", formula, "0.2.0", file]);

    expect(result.exitCode).toBe(0);
    const filled = readFileSync(formula, "utf8");
    expect(filled).toContain('version "0.2.0"');
    expect(shaAfterUrl(filled, "crisol-darwin-arm64")).toBe(sums["crisol-darwin-arm64"]);
    expect(shaAfterUrl(filled, "crisol-darwin-x64")).toBe(sums["crisol-darwin-x64"]);
    expect(filled).not.toContain("REPLACE_WITH");
  });

  test("fill replaces a previous release's values, since main carries them into the next tag", async () => {
    const formula = copyRepoFormula();
    const first = await shasumChecksums(BOTH);
    expect((await run(["bun", SCRIPT, "fill", formula, "0.2.0", first.file])).exitCode).toBe(0);

    const second = await shasumChecksums({
      "crisol-darwin-arm64": "next arm64 build",
      "crisol-darwin-x64": "next x64 build",
    });
    const result = await run(["bun", SCRIPT, "fill", formula, "0.3.0", second.file]);

    expect(result.exitCode).toBe(0);
    const filled = readFileSync(formula, "utf8");
    expect(filled).toContain('version "0.3.0"');
    expect(filled).not.toContain('version "0.2.0"');
    expect(shaAfterUrl(filled, "crisol-darwin-arm64")).toBe(second.sums["crisol-darwin-arm64"]);
    expect(shaAfterUrl(filled, "crisol-darwin-x64")).toBe(second.sums["crisol-darwin-x64"]);
    expect(second.sums["crisol-darwin-arm64"]).not.toBe(first.sums["crisol-darwin-arm64"]);
  });

  test("fill refuses a checksums.txt that lacks a binary, naming it and leaving the formula as it was", async () => {
    const formula = copyRepoFormula();
    const before = readFileSync(formula, "utf8");
    const { file } = await shasumChecksums({ "crisol-darwin-arm64": "arm64 build" });

    const result = await run(["bun", SCRIPT, "fill", formula, "0.2.0", file]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("crisol-darwin-x64");
    expect(readFileSync(formula, "utf8")).toBe(before);
  });

  test("check fails on a formula that still holds a placeholder, naming it", async () => {
    const result = await run(["bun", SCRIPT, "check", REPO_FORMULA]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("REPLACE_WITH_SHA256_OF_crisol-darwin-arm64");
    expect(result.stderr).toContain("REPLACE_WITH_SHA256_OF_crisol-darwin-x64");
  });

  test("check passes on a filled formula", async () => {
    const formula = copyRepoFormula();
    const { file } = await shasumChecksums(BOTH);
    expect((await run(["bun", SCRIPT, "fill", formula, "0.2.0", file])).exitCode).toBe(0);

    const result = await run(["bun", SCRIPT, "check", formula]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});
