import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PROJECT_DOCKERFILE, DEFAULT_PROJECT_IMAGE_TAG, contentHash } from "./docker";

const PROJECT_DOCKERFILE_FILE = path.join(".crisol", "Dockerfile");

/** Read from the host repo's working tree: the Clone doesn't exist yet. */
export function readProjectDockerfile(hostRepoPath: string): string | undefined {
  const dockerfilePath = path.join(hostRepoPath, PROJECT_DOCKERFILE_FILE);
  if (!existsSync(dockerfilePath)) return undefined;
  return readFileSync(dockerfilePath, "utf8");
}

export interface ProjectLayer {
  tag: string;
  dockerfile: string;
}

/**
 * Cached by the Dockerfile's own content hash — never by the repo's branch or commit — so the
 * same text reuses one image across repos and commits alike, and editing it is the only way to
 * invalidate the cache.
 */
export function resolveProjectLayer(dockerfileText: string | undefined): ProjectLayer {
  if (dockerfileText === undefined) {
    return { tag: DEFAULT_PROJECT_IMAGE_TAG, dockerfile: DEFAULT_PROJECT_DOCKERFILE };
  }
  return { tag: `crisol-project:${contentHash([dockerfileText])}`, dockerfile: dockerfileText };
}
