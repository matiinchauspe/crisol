import { readFileSync, writeFileSync } from "node:fs";

const BINARIES = ["crisol-darwin-arm64", "crisol-darwin-x64"] as const;
const PLACEHOLDER = /REPLACE_WITH_[A-Za-z0-9_.-]*/g;

function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
    if (match) sums.set(match[2]!, match[1]!);
  }
  return sums;
}

function fillFormula(formula: string, version: string, checksums: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`"${version}" is not a release version (expected MAJOR.MINOR.PATCH).`);
  }
  const sums = parseChecksums(checksums);

  let filled = replaceOnce(formula, /^(\s*version ")[^"]*(")/m, `$1${version}$2`, "the version line");
  for (const binary of BINARIES) {
    const sum = sums.get(binary);
    if (!sum) throw new Error(`checksums.txt has no sha256 for ${binary}.`);
    const line = new RegExp(`(/${binary}"\\s*\\n\\s*sha256 ")[^"]*(")`);
    filled = replaceOnce(filled, line, `$1${sum}$2`, `the sha256 line under ${binary}'s url`);
  }
  return filled;
}

function formulaPlaceholders(formula: string): string[] {
  return formula.match(PLACEHOLDER) ?? [];
}

function replaceOnce(text: string, pattern: RegExp, replacement: string, what: string): string {
  if (!pattern.test(text)) throw new Error(`The formula has no ${what}.`);
  return text.replace(pattern, replacement);
}

function main(args: string[]): number {
  const [command, formulaPath, ...rest] = args;
  if (command === "fill" && formulaPath && rest.length === 2) {
    const [version, checksumsPath] = rest as [string, string];
    const filled = fillFormula(readFileSync(formulaPath, "utf8"), version, readFileSync(checksumsPath, "utf8"));
    writeFileSync(formulaPath, filled);
    return 0;
  }
  if (command === "check" && formulaPath && rest.length === 0) {
    const placeholders = formulaPlaceholders(readFileSync(formulaPath, "utf8"));
    if (placeholders.length === 0) return 0;
    console.error(`${formulaPath} still holds placeholders: ${placeholders.join(", ")}.`);
    return 1;
  }
  console.error("Usage: formula.ts fill <formula> <version> <checksums.txt> | formula.ts check <formula>");
  return 2;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
