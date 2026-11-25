import { repoLevelChangeWarning, repoLevelRemovalWarning } from "./allowlist";
import { addedLines, fileRemoved } from "./git";
import { REPO_ALLOWLIST_FILE, REPO_CONFIG_FILE, REPO_DOCKERFILE_FILE, REPO_SERVICES_FILE } from "./paths";

/**
 * A Run reads `.crisol/` from its base commit, and `--base` can name the branch an agent wrote, so
 * the agent's declarations become the next Run's own. A removed file is read as absent, which
 * changes what the next Run does as much as an added one.
 */
export const DECLARATION_EFFECTS: readonly { file: string; effect: string; removal: string }[] = [
  {
    file: REPO_CONFIG_FILE,
    effect: "its Gates run and its `env` variables are copied from your environment into the Sandbox",
    removal: "the repo declares no Gates, so a Run ends `unverified` unless you pass `--gate`, and no `env` variable is copied",
  },
  {
    file: REPO_DOCKERFILE_FILE,
    effect: "it is built on your machine as the Project layer",
    removal: "the Project layer is Crisol's default one",
  },
  {
    file: REPO_SERVICES_FILE,
    effect: "the Services it declares are started on your machine",
    removal: "no Services are started",
  },
];

export function declarationChangeWarning(file: string, effect: string): string {
  return `the branch changes ${file}: a Run cut from this branch, or the repo once it is merged, reads it, and then ${effect}`;
}

export function declarationRemovalWarning(file: string, removal: string): string {
  return `the branch removes ${file}: a Run cut from this branch, or the repo once it is merged, reads the repo without it, and then ${removal}`;
}

/**
 * The range starts at the Run's own `baseSha`, never a round's start: a Continuation's earlier
 * rounds changed `.crisol/` too, and each round rewrites the result.
 */
export function crisolChangeWarnings(hostRepoPath: string, baseSha: string, tip: string): string[] {
  const range = `${baseSha}..${tip}`;
  const warnings: string[] = [];
  const networkChange = addedLines(hostRepoPath, range, REPO_ALLOWLIST_FILE);
  if (networkChange !== undefined) {
    warnings.push(fileRemoved(hostRepoPath, range, REPO_ALLOWLIST_FILE) ? repoLevelRemovalWarning() : repoLevelChangeWarning(networkChange));
  }
  for (const { file, effect, removal } of DECLARATION_EFFECTS) {
    if (addedLines(hostRepoPath, range, file) === undefined) continue;
    warnings.push(fileRemoved(hostRepoPath, range, file) ? declarationRemovalWarning(file, removal) : declarationChangeWarning(file, effect));
  }
  return warnings;
}
