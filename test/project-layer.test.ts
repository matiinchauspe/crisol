import { describe, expect, test } from "bun:test";
import { DEFAULT_PROJECT_DOCKERFILE, DEFAULT_PROJECT_IMAGE_TAG } from "../src/docker";
import { readProjectDockerfile, resolveProjectLayer } from "../src/project-layer";
import { commitFiles, createFixtureRepo, headSha } from "./support/fixtureRepo";

describe("readProjectDockerfile (ticket 12)", () => {
  test("reads .crisol/Dockerfile as the commit commits it, when present", () => {
    const repo = createFixtureRepo();
    try {
      commitFiles(repo.path, { ".crisol/Dockerfile": "FROM alpine:3.20\n" }, "chore: declare a Project layer");
      expect(readProjectDockerfile(repo.path, headSha(repo.path))).toBe("FROM alpine:3.20\n");
    } finally {
      repo.cleanup();
    }
  });

  test("returns undefined when the commit carries no .crisol/Dockerfile", () => {
    const repo = createFixtureRepo();
    try {
      expect(readProjectDockerfile(repo.path, headSha(repo.path))).toBeUndefined();
    } finally {
      repo.cleanup();
    }
  });
});

describe("resolveProjectLayer (ticket 12)", () => {
  test("no Dockerfile text resolves to Crisol's own default Project layer", () => {
    const layer = resolveProjectLayer(undefined);
    expect(layer.tag).toBe(DEFAULT_PROJECT_IMAGE_TAG);
    expect(layer.dockerfile).toBe(DEFAULT_PROJECT_DOCKERFILE);
  });

  test("a repo Dockerfile is tagged by its own content hash, never by a branch or commit", () => {
    const layer = resolveProjectLayer("FROM alpine:3.20\nRUN apk add --no-cache jq\n");
    expect(layer.tag).toMatch(/^crisol-project:[0-9a-f]{12}$/);
    expect(layer.dockerfile).toBe("FROM alpine:3.20\nRUN apk add --no-cache jq\n");
  });

  test("the same Dockerfile text reuses the same tag", () => {
    const a = resolveProjectLayer("FROM alpine:3.20\n");
    const b = resolveProjectLayer("FROM alpine:3.20\n");
    expect(a.tag).toBe(b.tag);
  });

  test("a different Dockerfile text gets a different tag", () => {
    const a = resolveProjectLayer("FROM alpine:3.20\n");
    const b = resolveProjectLayer("FROM alpine:3.21\n");
    expect(a.tag).not.toBe(b.tag);
  });
});
