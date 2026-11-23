import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeCodeAdapter, buildAgentLayerDockerfile, buildAgentLayerSpec } from "../src/adapters/claude-code";
import {
  UNSUPPORTED_BASE_MESSAGE,
  assertInstallableBase,
  contentHash,
  ensureImageFromDockerfile,
} from "../src/docker";
import { TENAZA_RELEASE } from "../src/tenaza";

// A real release, so the native installer has something to download: what `claude --version`
// printed on the host that wrote this test.
const CLAUDE_CODE_VERSION = "2.1.283";

/** Tagged by the Dockerfile's own text, so an edit to the layer never passes on a stale build. */
async function buildProjectImage(dockerfile: string): Promise<string> {
  return ensureImageFromDockerfile(`crisol-test-project:${contentHash([dockerfile])}`, dockerfile);
}

async function buildAgentLayer(projectImage: string): Promise<string> {
  await assertInstallableBase(projectImage);
  const dockerfile = buildAgentLayerDockerfile({
    baseImage: projectImage,
    claudeCodeVersion: CLAUDE_CODE_VERSION,
    tenaza: TENAZA_RELEASE,
  });
  return ensureImageFromDockerfile(`crisol-test-agent:${contentHash([dockerfile])}`, dockerfile);
}

function inside(image: string, script: string): string {
  const proc = Bun.spawnSync(["docker", "run", "--rm", "--pull", "never", image, "bash", "-c", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`\`${script}\` failed in ${image}: ${proc.stderr.toString("utf8")}`);
  }
  return proc.stdout.toString("utf8").trim();
}

function expectAWorkingAgentLayer(image: string): void {
  expect(inside(image, "id -un; id -u")).toBe("agent\n1000");
  expect(inside(image, "claude --version")).toBe(`${CLAUDE_CODE_VERSION} (Claude Code)`);
  expect(inside(image, "tenaza --version")).toBe(TENAZA_RELEASE.version);
  expect(inside(image, "command -v git rg curl")).toBe("/usr/bin/git\n/usr/bin/rg\n/usr/bin/curl");
}

describe("the Agent layer builds on the Project layer bases a repo brings", () => {
  test(
    "a Debian image",
    async () => {
      expectAWorkingAgentLayer(await buildAgentLayer("debian:bookworm-slim"));
    },
    600_000,
  );

  test(
    "an Ubuntu image, whose `ubuntu` account already holds uid 1000",
    async () => {
      expectAWorkingAgentLayer(await buildAgentLayer("ubuntu:24.04"));
    },
    600_000,
  );

  test(
    "a node:*-alpine image left on its own `node` user, which already holds uid 1000",
    async () => {
      const project = await buildProjectImage("FROM node:22-alpine\nUSER node\n");
      const agent = await buildAgentLayer(project);
      expectAWorkingAgentLayer(agent);
      expect(inside(agent, "node --version")).toStartWith("v22.");
    },
    600_000,
  );
});

describe("a Project layer base with neither apk nor apt-get", () => {
  test("is refused before `docker build`, naming the constraint", async () => {
    const project = await buildProjectImage("FROM alpine:3.20\nRUN rm /sbin/apk\n");
    const adapter = new ClaudeCodeAdapter({
      hostVersion: () => CLAUDE_CODE_VERSION,
      tenazaHome: path.join(mkdtempSync(path.join(tmpdir(), "crisol-no-tenaza-")), ".tenaza"),
    });
    const { tag } = buildAgentLayerSpec({ baseImage: project, claudeCodeVersion: CLAUDE_CODE_VERSION });

    const refusal = await adapter.declarePreStart(project).ensureImage!().catch((error: Error) => error);
    expect((refusal as Error).message).toBe(UNSUPPORTED_BASE_MESSAGE);
    expect(Bun.spawnSync(["docker", "image", "inspect", tag]).exitCode).not.toBe(0);
  }, 60_000);

  test("is what an image without even a shell is refused as", async () => {
    const project = await buildProjectImage("FROM scratch\nCOPY --from=alpine:3.20 /etc/passwd /etc/passwd\n");
    await expect(assertInstallableBase(project)).rejects.toThrow(UNSUPPORTED_BASE_MESSAGE);
  }, 60_000);

  test("is never claimed when the probe container could not start at all", async () => {
    const refusal = await assertInstallableBase("crisol-test-never-built:none").catch((error: Error) => error);
    expect((refusal as Error).message).toStartWith("Could not start crisol-test-never-built:none");
  }, 60_000);
});
