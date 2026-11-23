import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "../src/run";
import type { RunResult } from "../src/run";
import { buildServiceRunArgs, parseServicesYaml, readRepoServices } from "../src/services";
import type { Adapter, AdapterContext } from "../src/adapter";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";
import { runCli } from "./support/cli";

function writeServicesYaml(repoPath: string, yaml: string): void {
  mkdirSync(path.join(repoPath, ".crisol"), { recursive: true });
  writeFileSync(path.join(repoPath, ".crisol", "services.yml"), yaml);
}

function dockerInspect(name: string): string | undefined {
  const proc = Bun.spawnSync(["docker", "inspect", "--format", "{{.Id}}", name], { stdout: "pipe", stderr: "pipe" });
  return proc.exitCode === 0 ? proc.stdout.toString("utf8").trim() : undefined;
}

/** A single-command script the sandbox runs, committing its result to a file so a test outside the Sandbox can read it. */
function scriptAdapter(script: readonly string[]): Adapter {
  return {
    declarePreStart() {
      return { envNames: [], mounts: [] };
    },
    async launch(ctx: AdapterContext) {
      for (const line of script) {
        const result = await ctx.sandbox.exec(["bash", "-c", line]);
        if (result.exitCode !== 0) throw new Error(`script step "${line}" failed: ${result.stderr.trim()}`);
      }
    },
    async reportCompletion() {
      return true;
    },
    async resumeWithFeedback() {},
  };
}

describe("parseServicesYaml: a restricted compose subset, no Docker needed", () => {
  test("reads image, a nested environment mapping, and a healthcheck's flow-sequence test", () => {
    const yaml = [
      "services:",
      "  db:",
      "    image: postgres:16-alpine",
      "    environment:",
      "      POSTGRES_PASSWORD: crisol",
      "      POSTGRES_DB: app",
      "    healthcheck:",
      '      test: ["CMD-SHELL", "pg_isready -U postgres"]',
      "      interval: 1s",
      "      timeout: 2s",
      "      retries: 30",
      "      start_period: 0s",
      "",
    ].join("\n");
    const services = parseServicesYaml(yaml, "services.yml");
    expect(services).toEqual([
      {
        name: "db",
        image: "postgres:16-alpine",
        environment: { POSTGRES_PASSWORD: "crisol", POSTGRES_DB: "app" },
        healthcheck: {
          test: ["CMD-SHELL", "pg_isready -U postgres"],
          interval: "1s",
          timeout: "2s",
          retries: 30,
          startPeriod: "0s",
        },
      },
    ]);
  });

  test("reads more than one service, each independently", () => {
    const yaml = ["services:", "  db:", "    image: postgres:16-alpine", "  cache:", "    image: redis:7-alpine", ""].join(
      "\n",
    );
    expect(parseServicesYaml(yaml, "services.yml").map((s) => s.name)).toEqual(["db", "cache"]);
  });

  test("environment also accepts compose's list form, KEY=VALUE", () => {
    const yaml = ["services:", "  db:", "    image: x", "    environment:", "      - FOO=bar", "      - BAZ=1", ""].join(
      "\n",
    );
    expect(parseServicesYaml(yaml, "services.yml")[0]!.environment).toEqual({ FOO: "bar", BAZ: "1" });
  });

  test("a scalar command is wrapped like compose's shell form", () => {
    const yaml = ["services:", "  db:", "    image: x", "    command: echo hi", ""].join("\n");
    expect(parseServicesYaml(yaml, "services.yml")[0]!.command).toEqual(["sh", "-c", "echo hi"]);
  });

  test("a list command is read as exec-form argv", () => {
    const yaml = ["services:", "  db:", "    image: x", '    command: ["sleep", "5"]', ""].join("\n");
    expect(parseServicesYaml(yaml, "services.yml")[0]!.command).toEqual(["sleep", "5"]);
  });

  test("no services.yml at all: readRepoServices returns no services, no error", () => {
    const repo = createFixtureRepo();
    try {
      expect(readRepoServices(repo.path)).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });

  test("an empty `services:` key yields no services", () => {
    expect(parseServicesYaml("services:\n", "services.yml")).toEqual([]);
  });

  test("a top-level key other than \"services\" is rejected, naming it", () => {
    expect(() => parseServicesYaml("version: '3'\nservices:\n  db:\n    image: x\n", "services.yml")).toThrow(
      /unexpected top-level key "version"/,
    );
  });

  test("any compose key outside image/environment/command/healthcheck is rejected, naming it", () => {
    const yaml = ["services:", "  db:", "    image: x", "    ports:", '      - "5432:5432"', ""].join("\n");
    expect(() => parseServicesYaml(yaml, "services.yml")).toThrow(/service "db" has key "ports"/);
  });

  test("a healthcheck key outside test/interval/timeout/retries/start_period is rejected, naming it", () => {
    const yaml = ["services:", "  db:", "    image: x", "    healthcheck:", '      test: ["NONE"]', "      disable: true", ""].join(
      "\n",
    );
    expect(() => parseServicesYaml(yaml, "services.yml")).toThrow(/"healthcheck" has key "disable"/);
  });

  test("healthcheck.test must start with CMD, CMD-SHELL or NONE", () => {
    const yaml = ["services:", "  db:", "    image: x", "    healthcheck:", '      test: ["PING"]', ""].join("\n");
    expect(() => parseServicesYaml(yaml, "services.yml")).toThrow(/must start with "CMD", "CMD-SHELL", or "NONE"/);
  });

  test("a service missing \"image\" is rejected", () => {
    expect(() => parseServicesYaml("services:\n  db:\n    command: echo hi\n", "services.yml")).toThrow(/"image"/);
  });
});

describe("buildServiceRunArgs: the docker run shape, no Docker needed", () => {
  test("joins the given network under the service's own name as its alias, labelled for sweep-up", () => {
    const args = buildServiceRunArgs("run1", "crisol-net-run1", {
      name: "db",
      image: "postgres:16-alpine",
      environment: { POSTGRES_PASSWORD: "x" },
    });
    expect(args).toEqual([
      "docker",
      "run",
      "-d",
      "--rm",
      "--init",
      "--network",
      "crisol-net-run1",
      "--network-alias",
      "db",
      "--name",
      "crisol-svc-run1-db",
      "--label",
      "crisol.run=run1",
      "-e",
      "POSTGRES_PASSWORD=x",
      "postgres:16-alpine",
    ]);
  });

  test("a CMD-SHELL healthcheck becomes --health-cmd verbatim, with its timing flags", () => {
    const args = buildServiceRunArgs("run1", "net", {
      name: "db",
      image: "x",
      healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: "1s", retries: 30 },
    });
    expect(args).toContain("--health-cmd");
    expect(args[args.indexOf("--health-cmd") + 1]).toBe("pg_isready -U postgres");
    expect(args).toContain("--health-interval");
    expect(args[args.indexOf("--health-interval") + 1]).toBe("1s");
    expect(args).toContain("--health-retries");
    expect(args[args.indexOf("--health-retries") + 1]).toBe("30");
  });

  test("a CMD (exec-form) healthcheck is quoted and joined into one shell command", () => {
    const args = buildServiceRunArgs("run1", "net", {
      name: "cache",
      image: "x",
      healthcheck: { test: ["CMD", "redis-cli", "ping"] },
    });
    expect(args[args.indexOf("--health-cmd") + 1]).toBe("'redis-cli' 'ping'");
  });

  test("NONE sets no health flags at all", () => {
    const args = buildServiceRunArgs("run1", "net", { name: "db", image: "x", healthcheck: { test: ["NONE"] } });
    expect(args).not.toContain("--health-cmd");
  });

  test("a declared command is appended after the image", () => {
    const args = buildServiceRunArgs("run1", "net", { name: "db", image: "x", command: ["sleep", "5"] });
    expect(args.slice(-3)).toEqual(["x", "sleep", "5"]);
  });
});

describe("Services end to end, against a real Docker engine", () => {
  test(
    "a Gate that connects to db:5432 passes inside the Run",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        writeServicesYaml(
          repo.path,
          [
            "services:",
            "  db:",
            "    image: postgres:16-alpine",
            "    environment:",
            "      POSTGRES_PASSWORD: crisol",
            "    healthcheck:",
            '      test: ["CMD-SHELL", "pg_isready -U postgres"]',
            "      interval: 1s",
            "      timeout: 2s",
            "      retries: 30",
            "",
          ].join("\n"),
        );

        const result = await run({
          task: "reach the declared service",
          cwd: repo.path,
          home: home.path,
          gates: ["timeout 5 bash -c '</dev/tcp/db/5432' && echo connected"],
        });

        expect(result.status).toBe("verified");
        expect(result.gates).toEqual([{ cmd: "timeout 5 bash -c '</dev/tcp/db/5432' && echo connected", ok: true }]);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "any compose key outside the four allowed fails the Run before any side effect, naming it",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        writeServicesYaml(repo.path, ["services:", "  db:", "    image: postgres:16-alpine", "    ports:", '      - "5432:5432"', ""].join("\n"));

        const result = await runCli(["run", "say hello", "--json", "--adapter", "fake"], { cwd: repo.path, home: home.path });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('service "db" has key "ports"');
        expect(existsSync(path.join(home.path, "runs"))).toBe(false);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    30_000,
  );

  test(
    "the agent starts only after the healthcheck passes",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        // The entrypoint's own init only runs once its first argument is "postgres" again — a
        // standard way to make an official image's startup artificially slow for a test. Until
        // then `pg_isready` fails, so a correct Crisol holds the agent back until the delay has
        // passed and the real startup has made it ready.
        writeServicesYaml(
          repo.path,
          [
            "services:",
            "  db:",
            "    image: postgres:16-alpine",
            "    environment:",
            "      POSTGRES_PASSWORD: crisol",
            '    command: ["sh", "-c", "sleep 3 && docker-entrypoint.sh postgres"]',
            "    healthcheck:",
            '      test: ["CMD-SHELL", "pg_isready -U postgres"]',
            "      interval: 1s",
            "      timeout: 2s",
            "      retries: 30",
            "",
          ].join("\n"),
        );

        const result = await run({
          task: "probe db on launch",
          cwd: repo.path,
          home: home.path,
          adapter: scriptAdapter([
            "timeout 3 bash -c '</dev/tcp/db/5432' && echo connected > DB_UP.txt || echo failed > DB_UP.txt",
            "git add DB_UP.txt",
            "git commit --quiet -m 'test: probe db on launch'",
          ]),
        });

        const probe = Bun.spawnSync(["git", "-C", repo.path, "show", `${result.branch}:DB_UP.txt`], {
          stdout: "pipe",
        }).stdout.toString("utf8").trim();
        expect(probe).toBe("connected");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "a never-healthy service fails the Run with iterations: 0, before the agent runs",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        writeServicesYaml(
          repo.path,
          [
            "services:",
            "  flaky:",
            "    image: alpine:3.20",
            '    command: ["tail", "-f", "/dev/null"]',
            "    healthcheck:",
            '      test: ["CMD-SHELL", "exit 1"]',
            "      interval: 1s",
            "      timeout: 1s",
            "      retries: 1",
            "      start_period: 0s",
            "",
          ].join("\n"),
        );

        let launched = false;
        // The service failure throws, like `startNetworkWall`'s own pre-flight failures do — so
        // the Run result lives only in `result.json`, not in a resolved return value.
        await expect(
          run({
            task: "never reached because the service never heals",
            cwd: repo.path,
            home: home.path,
            adapter: {
              declarePreStart() {
                return { envNames: [], mounts: [] };
              },
              async launch() {
                launched = true;
              },
              async reportCompletion() {
                return true;
              },
              async resumeWithFeedback() {},
            },
          }),
        ).rejects.toThrow(/flaky/);

        expect(launched).toBe(false);
        const [runId] = readdirSync(path.join(home.path, "runs"));
        const result = JSON.parse(
          readFileSync(path.join(home.path, "runs", runId!, "result.json"), "utf8"),
        ) as RunResult;
        expect(result.status).toBe("not-converged");
        expect(result.iterations).toBe(0);
        expect(result.reason).toContain("flaky");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    30_000,
  );

  test(
    "two parallel Runs each get their own service instance; both are gone after the Runs end",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        writeServicesYaml(
          repo.path,
          [
            "services:",
            "  db:",
            "    image: postgres:16-alpine",
            "    environment:",
            "      POSTGRES_PASSWORD: crisol",
            "    healthcheck:",
            '      test: ["CMD-SHELL", "pg_isready -U postgres"]',
            "      interval: 1s",
            "      timeout: 2s",
            "      retries: 30",
            "",
          ].join("\n"),
        );

        const gate = "timeout 5 bash -c '</dev/tcp/db/5432' && echo connected";
        const [a, b] = await Promise.all([
          run({ task: "run a", cwd: repo.path, home: home.path, gates: [gate], name: "crisol-svc-parallel-a" }),
          run({ task: "run b", cwd: repo.path, home: home.path, gates: [gate], name: "crisol-svc-parallel-b" }),
        ]);

        expect(a.status).toBe("verified");
        expect(b.status).toBe("verified");
        expect(a.run).not.toBe(b.run);

        expect(dockerInspect(`crisol-svc-${a.run}-db`)).toBeUndefined();
        expect(dockerInspect(`crisol-svc-${b.run}-db`)).toBeUndefined();
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    90_000,
  );

  test(
    "network open plus a declared service: the Sandbox keeps the internet AND reaches the service",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        writeServicesYaml(
          repo.path,
          [
            "services:",
            "  db:",
            "    image: postgres:16-alpine",
            "    environment:",
            "      POSTGRES_PASSWORD: crisol",
            "    healthcheck:",
            '      test: ["CMD-SHELL", "pg_isready -U postgres"]',
            "      interval: 1s",
            "      timeout: 2s",
            "      retries: 30",
            "",
          ].join("\n"),
        );

        const result = await run({
          task: "open network plus a service",
          cwd: repo.path,
          home: home.path,
          network: "open",
          gates: [
            "curl -fsS --max-time 20 -o /dev/null https://registry.npmjs.org/ && " +
              "timeout 5 bash -c '</dev/tcp/db/5432' && echo both-reachable",
          ],
        });

        expect(result.status).toBe("verified");
        expect(result.network).toBe("open");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );
});
