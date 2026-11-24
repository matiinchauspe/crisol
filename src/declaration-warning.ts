import { REPO_CONFIG_FILE, REPO_DOCKERFILE_FILE, REPO_SERVICES_FILE } from "./paths";

/**
 * A Run reads `.crisol/` from its base commit, and `--base` can name the branch an agent wrote, so
 * the agent's declarations become the next Run's own.
 */
export const DECLARATION_EFFECTS: readonly { file: string; effect: string }[] = [
  { file: REPO_CONFIG_FILE, effect: "its Gates run and its `env` variables are copied from your environment into the Sandbox" },
  { file: REPO_DOCKERFILE_FILE, effect: "it is built on your machine as the Project layer" },
  { file: REPO_SERVICES_FILE, effect: "the Services it declares are started on your machine" },
];

export function declarationChangeWarning(file: string, effect: string): string {
  return `the branch changes ${file}: a Run cut from this branch, or the repo once it is merged, reads it, and then ${effect}`;
}
