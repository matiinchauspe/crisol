import { DEFAULT_PROJECT_DOCKERFILE, DEFAULT_PROJECT_IMAGE_TAG, contentHash } from "./docker";
import { readTextAtCommit } from "./git";
import { REPO_DOCKERFILE_FILE } from "./paths";

export function readProjectDockerfile(hostRepoPath: string, baseSha: string): string | undefined {
  return readTextAtCommit(hostRepoPath, baseSha, REPO_DOCKERFILE_FILE);
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
