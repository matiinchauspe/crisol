import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Adapter } from "../src/adapter";
import { FakeAdapter } from "../src/adapters/fake";
import { buildDockerRunArgs } from "../src/docker";
import { run } from "../src/run";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

describe("FakeAdapter's pre-start declaration (Adapter split)", () => {
  test("declares no secrets, mounts or image", () => {
    expect(new FakeAdapter().declarePreStart()).toEqual({ envNames: [], mounts: [] });
  });
});

describe("buildDockerRunArgs never puts a secret's VALUE on the argv (Adapter split)", () => {
  test("a declared secret env name appears bare; its value never does", () => {
    process.env.CRISOL_TEST_SECRET_FOR_ARGS = "super-secret-value";
    try {
      const args = buildDockerRunArgs({
        image: "crisol-base:test",
        mountPath: "/tmp/some-clone",
        env: { GIT_AUTHOR_NAME: "A" },
        secretEnvNames: ["CRISOL_TEST_SECRET_FOR_ARGS"],
        mounts: [],
        id: "argstest",
      });
      expect(args).toContain("CRISOL_TEST_SECRET_FOR_ARGS");
      expect(args.join(" ")).not.toContain("super-secret-value");
      // Non-secret env is fine as KEY=value — only declared secrets get the bare-name treatment.
      expect(args).toContain("GIT_AUTHOR_NAME=A");
    } finally {
      delete process.env.CRISOL_TEST_SECRET_FOR_ARGS;
    }
  });

  test("declares --init, --name crisol-<id> and --label crisol.run=<id>", () => {
    const args = buildDockerRunArgs({
      image: "crisol-base:test",
      mountPath: "/tmp/x",
      env: {},
      id: "abc123",
    });
    expect(args).toContain("--init");
    expect(args).toContain("crisol-abc123");
    expect(args).toContain("crisol.run=abc123");
  });

  test("declares --pull never (extra: never let docker reach a registry for Crisol's own image)", () => {
    const args = buildDockerRunArgs({
      image: "crisol-base:test",
      mountPath: "/tmp/x",
      env: {},
      id: "pulltest",
    });
    const pullIndex = args.indexOf("--pull");
    expect(pullIndex).toBeGreaterThan(-1);
    expect(args[pullIndex + 1]).toBe("never");
  });

  test("mounts use --mount, never a bare -v (extra)", () => {
    const args = buildDockerRunArgs({
      image: "crisol-base:test",
      mountPath: "/tmp/some-clone",
      env: {},
      mounts: [{ hostPath: "/tmp/ro-dir", containerPath: "/mnt/ro", mode: "ro" }],
      id: "mounttest",
    });
    expect(args).not.toContain("-v");
    expect(args).toContain("--mount");
    expect(args).toContain("type=bind,source=/tmp/some-clone,target=/tmp/some-clone");
    expect(args).toContain("type=bind,source=/tmp/ro-dir,target=/mnt/ro,readonly");
  });
});

describe("the pre-start declaration end to end, against a real Sandbox (Adapter split)", () => {
  test("secret env (by name), a ro mount, and a rw mount are all wired before the Adapter ever runs", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const roHostDir = mkdtempSync(path.join(tmpdir(), "crisol-ro-"));
    const rwHostDir = mkdtempSync(path.join(tmpdir(), "crisol-rw-"));
    writeFileSync(path.join(roHostDir, "config.txt"), "readonly-config\n");
    process.env.CRISOL_TEST_TOKEN = "s3cr3t";
    try {
      const declaringAdapter: Adapter = {
        declarePreStart() {
          return {
            envNames: ["CRISOL_TEST_TOKEN"],
            mounts: [
              { hostPath: roHostDir, containerPath: "/mnt/ro", mode: "ro" },
              { hostPath: rwHostDir, containerPath: "/mnt/rw", mode: "rw" },
            ],
          };
        },
        async launch(ctx) {
          const probe = await ctx.sandbox.exec([
            "bash",
            "-c",
            [
              'echo "token=$CRISOL_TEST_TOKEN" > probe.txt',
              '(echo bad > /mnt/ro/write-attempt.txt && echo "ro-write=succeeded" >> probe.txt) ' +
                '|| echo "ro-write=blocked" >> probe.txt',
              'echo hello > /mnt/rw/ok.txt && echo "rw-write=succeeded" >> probe.txt ' +
                '|| echo "rw-write=blocked" >> probe.txt',
              "git add probe.txt",
              "git commit --quiet -m 'test: pre-start declaration probe'",
            ].join("\n"),
          ]);
          if (probe.exitCode !== 0) {
            throw new Error(`probe failed: ${probe.stderr}`);
          }
        },
        async reportCompletion() {
          return true;
        },
        async resumeWithFeedback() {},
      };

      const result = await run({
        task: "probe the pre-start declaration",
        cwd: repo.path,
        home: home.path,
        adapter: declaringAdapter,
      });

      const probeText = Bun.spawnSync(
        ["git", "-C", repo.path, "show", `${result.branch}:probe.txt`],
        { stdout: "pipe" },
      ).stdout.toString("utf8");

      expect(probeText).toContain("token=s3cr3t");
      expect(probeText).toContain("ro-write=blocked");
      expect(probeText).toContain("rw-write=succeeded");
      // The rw mount is a REAL bind mount — the write is visible on the host.
      expect(existsSync(path.join(rwHostDir, "ok.txt"))).toBe(true);
    } finally {
      delete process.env.CRISOL_TEST_TOKEN;
      home.cleanup();
      repo.cleanup();
      rmSync(roHostDir, { recursive: true, force: true });
      rmSync(rwHostDir, { recursive: true, force: true });
    }
  }, 60_000);
});
