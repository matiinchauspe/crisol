import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "../src/adapter";
import { ClaudeCodeAdapter, buildAgentLayerDockerfile, buildAgentLayerSpec } from "../src/adapters/claude-code";
import { contentHash, ensureDefaultProjectImage, ensureImageFromDockerfile, type ExecResult, type Sandbox } from "../src/docker";
import { discoverGitRoot } from "../src/git";
import { runRepoPath, runSessionIdPath } from "../src/paths";
import { run } from "../src/run";
import { CLAUDE_TOKEN_SECRET_NAME, type SecretStore } from "../src/secret-store";
import { TENAZA_RELEASE, tenazaLayerSteps } from "../src/tenaza";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

interface TenazaHome {
  path: string;
  cleanup(): void;
}

function createTenazaHome(): TenazaHome {
  const home = mkdtempSync(path.join(tmpdir(), "crisol-tenaza-home-"));
  return { path: home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function missingTenazaHome(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "crisol-no-tenaza-")), ".tenaza");
}

function settingsFrom(dockerfile: string): { hooks?: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]> } {
  const match = /printf '%s' '(.+)' > \/home\/agent\/.claude\/settings\.json/.exec(dockerfile);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

describe("the pinned Tenaza release", () => {
  test("is v0.5.2's musl builds, with the sha256s its release publishes", () => {
    // Verify with: gh release view v0.5.2 -R matiinchauspe/tenaza
    expect(TENAZA_RELEASE.version).toBe("0.5.2");
    expect(TENAZA_RELEASE.assets).toEqual({
      aarch64: {
        name: "tenaza-linux-arm64-musl",
        sha256: "a61fff23e27af6434275e2fa2e2bfd8994c128901a9201f3453584eb788bfcac",
      },
      x86_64: {
        name: "tenaza-linux-x64-musl",
        sha256: "7989c7cc44109115ea07e0d60b3e2ceab6896a586935364ecc161cb3449cfc49",
      },
    });
  });

  test("the layer steps download the arch's asset from the release, verify its sha256, and add the libraries it links", () => {
    const steps = tenazaLayerSteps(TENAZA_RELEASE, "/home/agent/.tenaza").join("\n");
    expect(steps).toContain("https://github.com/matiinchauspe/tenaza/releases/download/v0.5.2/");
    expect(steps).toContain("uname -m");
    for (const asset of Object.values(TENAZA_RELEASE.assets)) {
      expect(steps).toContain(asset.name);
      expect(steps).toContain(asset.sha256);
    }
    expect(steps).toContain("sha256sum -c");
    expect(steps).toContain("apk add --no-cache libgcc libstdc++");
    expect(steps).toContain("ENV TENAZA_HOME=/home/agent/.tenaza");
  });
});

describe("the Agent layer with and without Tenaza", () => {
  test("with Tenaza, the layer installs it before switching to the agent user and bakes its Claude Code hooks", () => {
    const dockerfile = buildAgentLayerDockerfile({
      baseImage: "crisol-base:test",
      claudeCodeVersion: "9.9.9",
      tenaza: TENAZA_RELEASE,
    });
    const install = dockerfile.indexOf("tenaza-linux-");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(dockerfile.indexOf("USER agent"));

    const hooks = settingsFrom(dockerfile).hooks!;
    expect(Object.keys(hooks).sort()).toEqual(
      [
        "Notification",
        "PostToolUse",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "SubagentStart",
        "SubagentStop",
        "UserPromptSubmit",
      ].sort(),
    );
    for (const entries of Object.values(hooks)) {
      expect(entries).toHaveLength(1);
      expect(entries[0]!.hooks.map((hook) => hook.command)).toEqual(["tenaza hook claude"]);
    }
    expect(hooks.PreToolUse![0]!.matcher).toBe("Bash|mcp__.*");
    expect(hooks.PreToolUse![0]!.hooks[0]!.timeout).toBe(240);
    expect(hooks.Notification![0]!.matcher).toBe("permission_prompt|idle_prompt");
  });

  test("without Tenaza, the layer carries neither the binary nor any hook", () => {
    const dockerfile = buildAgentLayerDockerfile({ baseImage: "crisol-base:test", claudeCodeVersion: "9.9.9" });
    expect(dockerfile).not.toContain("tenaza");
    expect(settingsFrom(dockerfile).hooks).toBeUndefined();
  });

  test("a changed Tenaza version rebuilds the Agent layer: a new tag and a new download", () => {
    const previous = { ...TENAZA_RELEASE, version: "0.5.0" };
    const current = buildAgentLayerSpec({ baseImage: "crisol-base:test", claudeCodeVersion: "1.2.3", tenaza: TENAZA_RELEASE });
    const older = buildAgentLayerSpec({ baseImage: "crisol-base:test", claudeCodeVersion: "1.2.3", tenaza: previous });
    const absent = buildAgentLayerSpec({ baseImage: "crisol-base:test", claudeCodeVersion: "1.2.3" });
    expect(current.tag).not.toBe(older.tag);
    expect(current.tag).not.toBe(absent.tag);
    expect(older.dockerfile).toContain("/download/v0.5.0/");
  });
});

describe("ClaudeCodeAdapter.declarePreStart reads the host's Tenaza home", () => {
  test("present: config mounted read-only and state read-write at the agent's own Tenaza home, and no no-guard reason", () => {
    const tenaza = createTenazaHome();
    try {
      mkdirSync(path.join(tenaza.path, "state"));
      const declaration = new ClaudeCodeAdapter({ hostVersion: () => "9.9.9", tenazaHome: tenaza.path }).declarePreStart(
        "crisol-base:test",
      );
      expect(declaration.mounts).toEqual([
        { hostPath: path.join(tenaza.path, "config"), containerPath: "/home/agent/.tenaza/config", mode: "ro" },
        { hostPath: path.join(tenaza.path, "state"), containerPath: "/home/agent/.tenaza/state", mode: "rw" },
      ]);
      expect(declaration.unguarded).toBeUndefined();
    } finally {
      tenaza.cleanup();
    }
  });

  test("present without a config dir: the dir is created, so config is always mounted read-only", () => {
    const tenaza = createTenazaHome();
    try {
      new ClaudeCodeAdapter({ hostVersion: () => "9.9.9", tenazaHome: tenaza.path }).declarePreStart("crisol-base:test");
      expect(existsSync(path.join(tenaza.path, "config"))).toBe(true);
      expect(existsSync(path.join(tenaza.path, "state"))).toBe(true);
    } finally {
      tenaza.cleanup();
    }
  });

  test("absent: no mounts, nothing created, and the reason names the home it looked for", () => {
    const home = missingTenazaHome();
    const declaration = new ClaudeCodeAdapter({ hostVersion: () => "9.9.9", tenazaHome: home }).declarePreStart(
      "crisol-base:test",
    );
    expect(declaration.mounts).toEqual([]);
    expect(declaration.unguarded).toBe(`no Tenaza home at ${home}`);
    expect(existsSync(home)).toBe(false);
  });
});

function recordingSandbox(stdout: (cmd: string[]) => string): { sandbox: Sandbox; calls: { cmd: string[]; stdin?: string }[] } {
  const calls: { cmd: string[]; stdin?: string }[] = [];
  const sandbox: Sandbox = {
    containerId: "fake",
    mounts: [],
    async exec(cmd: string[], stdin?: string): Promise<ExecResult> {
      calls.push({ cmd, stdin });
      return { exitCode: 0, stdout: stdout(cmd), stderr: "" };
    },
    async stop() {
      return { ok: true, stderr: "" };
    },
  };
  return { sandbox, calls };
}

function context(sandbox: Sandbox, hostRepoPath: string): AdapterContext {
  return { sandbox, repoPath: "/clone", hostRepoPath, prompt: "fix the bug" };
}

describe("ClaudeCodeAdapter.launch labels the session with its project before the agent starts", () => {
  test("with Tenaza, a label for the host repo is handed to `tenaza hook claude` under the session id the agent is launched with", async () => {
    const tenaza = createTenazaHome();
    try {
      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9", tenazaHome: tenaza.path });
      adapter.declarePreStart("crisol-base:test");
      const { sandbox, calls } = recordingSandbox((cmd) =>
        cmd[0] === "fake-claude" ? JSON.stringify({ session_id: cmd[cmd.indexOf("--session-id") + 1], result: "ok" }) : "",
      );

      await adapter.launch(context(sandbox, "/Users/someone/projects/app"));

      expect(calls).toHaveLength(2);
      expect(calls[0]!.cmd).toEqual(["tenaza", "hook", "claude"]);
      const payload = JSON.parse(calls[0]!.stdin!);
      expect(payload).toMatchObject({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "tenaza label project=/Users/someone/projects/app" },
        cwd: "/clone",
      });
      const launchArgs = calls[1]!.cmd;
      expect(launchArgs[launchArgs.indexOf("--session-id") + 1]).toBe(payload.session_id);
      expect(adapter.sessionId()).toBe(payload.session_id);
    } finally {
      tenaza.cleanup();
    }
  });

  test("a host path a label cannot carry is left unlabelled, and the agent still launches", async () => {
    const tenaza = createTenazaHome();
    try {
      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9", tenazaHome: tenaza.path });
      adapter.declarePreStart("crisol-base:test");
      const { sandbox, calls } = recordingSandbox(() => JSON.stringify({ session_id: "sess-aaa", result: "ok" }));

      await adapter.launch(context(sandbox, "/Users/someone/My Projects/app"));

      expect(calls.map((call) => call.cmd[0])).toEqual(["fake-claude"]);
    } finally {
      tenaza.cleanup();
    }
  });

  test("without Tenaza, nothing is labelled and the launch argv is unchanged", async () => {
    const adapter = new ClaudeCodeAdapter({ binary: "fake-claude", hostVersion: () => "9.9.9", tenazaHome: missingTenazaHome() });
    adapter.declarePreStart("crisol-base:test");
    const { sandbox, calls } = recordingSandbox(() => JSON.stringify({ session_id: "sess-aaa", result: "ok" }));

    await adapter.launch(context(sandbox, "/Users/someone/projects/app"));

    expect(calls.map((call) => call.cmd)).toEqual([["fake-claude", "-p", "--dangerously-skip-permissions", "--output-format", "json"]]);
  });
});

function fakeSecretStore(): SecretStore {
  const values = new Map([[CLAUDE_TOKEN_SECRET_NAME, "stand-in-token"]]);
  return { get: (name) => values.get(name), set: (name, value) => void values.set(name, value) };
}

/** Commits a stand-in `claude` into the fixture repo, so the Clone carries it at a known path inside the Sandbox. */
function commitStandInClaude(repoPath: string, body: readonly string[]): void {
  const file = path.join(repoPath, "fake-claude");
  writeFileSync(
    file,
    [
      "#!/bin/bash",
      "set -e",
      'session=""',
      'while [ $# -gt 0 ]; do [ "$1" = "--session-id" ] && session="$2"; shift; done',
      // As the real `claude` does, it makes up its own session id when given none.
      '[ -n "$session" ] || session="$(cat /proc/sys/kernel/random/uuid)"',
      "cat > /dev/null",
      ...body,
      'printf \'{"session_id":"%s","result":"done"}\' "$session"',
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  for (const args of [["add", "fake-claude"], ["commit", "--quiet", "-m", "test: add a stand-in claude"]]) {
    const proc = Bun.spawnSync(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString("utf8"));
  }
}

async function ensureImageWithTenaza(): Promise<string> {
  const base = await ensureDefaultProjectImage();
  const dockerfile = [`FROM ${base}`, ...tenazaLayerSteps(TENAZA_RELEASE, "/home/agent/.tenaza"), ""].join("\n");
  return ensureImageFromDockerfile(`crisol-test-tenaza:${contentHash([dockerfile])}`, dockerfile);
}

function gitShow(repoPath: string, branch: string, file: string): string {
  return Bun.spawnSync(["git", "-C", repoPath, "show", `${branch}:${file}`], { stdout: "pipe" }).stdout.toString("utf8");
}

describe("a Run with Tenaza installed on the host", () => {
  test(
    "policy.toml stays unwritable, a reserved action lands in the host's Inbox, and the session is labelled with the host repo",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      const tenaza = createTenazaHome();
      const policy = '[[rule]]\nmatch = "git push"\neffect = "human"\n';
      try {
        mkdirSync(path.join(tenaza.path, "config"));
        writeFileSync(path.join(tenaza.path, "config", "policy.toml"), policy);
        commitStandInClaude(repo.path, [
          'if echo "# widened" >> "$TENAZA_HOME/config/policy.toml" 2>/dev/null; then echo writable; else echo read-only; fi > POLICY.txt',
          'printf \'{"session_id":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin HEAD"},"cwd":"%s"}\' "$session" "$PWD" | tenaza hook claude > HOOK.json',
          "git add POLICY.txt HOOK.json",
          "git commit --quiet -m 'test: attempt a reserved action'",
        ]);
        const runId = "tenaza01";
        const unguarded: string[] = [];

        const result = await run({
          task: "attempt a reserved action",
          cwd: repo.path,
          home: home.path,
          network: "open",
          generateRunId: () => runId,
          ensureImage: ensureImageWithTenaza,
          secretStore: fakeSecretStore(),
          onUnguarded: (line) => unguarded.push(line),
          adapter: new ClaudeCodeAdapter({
            binary: path.join(runRepoPath(runId, home.path), "fake-claude"),
            hostVersion: () => "9.9.9",
            tenazaHome: tenaza.path,
          }),
        });

        expect(result.status).toBe("unverified");
        expect(unguarded).toEqual([]);

        expect(gitShow(repo.path, result.branch, "POLICY.txt").trim()).toBe("read-only");
        expect(readFileSync(path.join(tenaza.path, "config", "policy.toml"), "utf8")).toBe(policy);

        const session = readFileSync(runSessionIdPath(runId, home.path), "utf8").trim();
        const hook = JSON.parse(gitShow(repo.path, result.branch, "HOOK.json"));
        expect(hook.hookSpecificOutput.permissionDecision).toBe("deny");
        const events = readFileSync(path.join(tenaza.path, "state", "sessions", `${session}.jsonl`), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events.some((event) => event.type === "action.decided" && event.data.decision === "deny")).toBe(true);
        expect(readdirSync(path.join(tenaza.path, "state", "relay-requested"))).toHaveLength(1);

        const labels = JSON.parse(readFileSync(path.join(tenaza.path, "state", "sessions", `${session}.labels`), "utf8"));
        expect(labels).toEqual({ project: discoverGitRoot(repo.path)! });
      } finally {
        home.cleanup();
        repo.cleanup();
        tenaza.cleanup();
      }
    },
    180_000,
  );
});

describe("a Run without Tenaza on the host", () => {
  test("completes and reports the missing guard exactly once", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    const tenazaHome = missingTenazaHome();
    try {
      commitStandInClaude(repo.path, [
        "echo done > DONE.txt",
        "git add DONE.txt",
        "git commit --quiet -m 'test: finish without a guard'",
      ]);
      const runId = "noguard1";
      const unguarded: string[] = [];

      const result = await run({
        task: "finish without a guard",
        cwd: repo.path,
        home: home.path,
        network: "open",
        generateRunId: () => runId,
        ensureImage: () => ensureDefaultProjectImage(),
        secretStore: fakeSecretStore(),
        onUnguarded: (line) => unguarded.push(line),
        adapter: new ClaudeCodeAdapter({
          binary: path.join(runRepoPath(runId, home.path), "fake-claude"),
          hostVersion: () => "9.9.9",
          tenazaHome,
        }),
      });

      expect(result.status).toBe("unverified");
      expect(gitShow(repo.path, result.branch, "DONE.txt").trim()).toBe("done");
      expect(unguarded).toEqual([`This Run has no reserved-action guard: no Tenaza home at ${tenazaHome}.`]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  }, 120_000);
});
