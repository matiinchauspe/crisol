import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_PROJECT_DOCKERFILE, DEFAULT_PROJECT_IMAGE_TAG } from "../src/docker";
import { readProjectDockerfile, resolveProjectLayer } from "../src/project-layer";

describe("readProjectDockerfile (ticket 12)", () => {
  test("reads .crisol/Dockerfile from the repo's working tree when present", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "crisol-project-layer-"));
    try {
      mkdirSync(path.join(repo, ".crisol"));
      writeFileSync(path.join(repo, ".crisol", "Dockerfile"), "FROM alpine:3.20\n");
      expect(readProjectDockerfile(repo)).toBe("FROM alpine:3.20\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("returns undefined when the repo carries no .crisol/Dockerfile", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "crisol-project-layer-"));
    try {
      expect(readProjectDockerfile(repo)).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
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
