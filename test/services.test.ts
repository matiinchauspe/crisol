import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "../src/run";
import type { RunResult } from "../src/run";
import { buildServiceRunArgs, parseServicesYaml, readRepoServices, splitCommandString, startServices } from "../src/services";
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

  test("a string command is split into argv, never wrapped in a shell", () => {
    const yaml = ["services:", "  db:", "    image: x", "    command: postgres -c fsync=off", ""].join("\n");
    expect(parseServicesYaml(yaml, "services.yml")[0]!.command).toEqual(["postgres", "-c", "fsync=off"]);
  });

  // Each argv is what `docker compose config --format json` printed for the same string on
  // Docker Compose v5.5.0 (compose-go v2.14.0, splitting with go-shellwords v1.0.14).
  test.each([
    ['postgres -c "log_line_prefix=%m [%p] "', ["postgres", "-c", "log_line_prefix=%m [%p] "]],
    ["a 'b c' d", ["a", "b c", "d"]],
    ["a\tb", ["a", "b"]],
    ["a\\ b", ["a b"]],
    ["a\\b", ["ab"]],
    ['"a\\b"', ["ab"]],
    ['"a\\\\b"', ["a\\b"]],
    ['"a\\"b"', ['a"b']],
    ["'a\\b'", ["a\\b"]],
    ["'a\\nb'", ["a\\nb"]],
    ["a\\nb", ["a\nb"]],
    ["a\\tb", ["a\tb"]],
    ["a\\'b", ["a'b"]],
    ['a"b"c', ["abc"]],
    ["'' \"\"", ["", ""]],
    ['"a;b"', ["a;b"]],
    ["a\\;b", ["a;b"]],
    ['"a(b)"', ["a(b)"]],
    ["a #b", ["a", "#b"]],
    ["x=1 y", ["x=1", "y"]],
    ["é ü", ["é", "ü"]],
    ["   ", []],
  ])("%p splits like compose", (text, argv) => {
    expect(splitCommandString(text)).toEqual(argv);
  });

  // The same compose run rejected each of these as "invalid command line string".
  test.each(["a\\", "a 'b", 'a "b', "a(b)", "a)"])("%p is rejected, as compose rejects it", (text) => {
    expect(() => splitCommandString(text)).toThrow(/unclosed quote|trailing backslash|bare/);
  });

  // Compose stops at an unquoted `;`, `&`, `|`, `<` or `>` and drops the rest (`a;b` → ["a"]), and
  // passes `$(…)` and backticks through as literal text; either way the author meant a shell.
  test.each(["a;b", "a && b", "a | b", "a > out", "a $(b)", "a `b`"])("%p is rejected as shell syntax", (text) => {
    expect(() => splitCommandString(text)).toThrow(/\["sh", "-c", /);
  });

  test("a rejected string command names its service and file", () => {
    const yaml = ["services:", "  db:", "    image: x", "    command: a && b", ""].join("\n");
    expect(() => parseServicesYaml(yaml, "services.yml")).toThrow(/^services\.yml: service "db"'s "command"/);
  });

  test("a string healthcheck test means CMD-SHELL with that string", () => {
    const yaml = ["services:", "  db:", "    image: x", "    healthcheck:", "      test: pg_isready -U postgres", ""].join("\n");
    expect(parseServicesYaml(yaml, "services.yml")[0]!.healthcheck!.test).toEqual(["CMD-SHELL", "pg_isready -U postgres"]);
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
  test("joins the given network under the service's own name as its alias, labelled for sweep-up, and outlives its own exit", () => {
    const args = buildServiceRunArgs("run1", "crisol-net-run1", {
      name: "db",
      image: "postgres:16-alpine",
      environment: { POSTGRES_PASSWORD: "x" },
    });
    expect(args).toEqual([
      "docker",
      "run",
      "-d",
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
  // The image's docker-entrypoint.sh dispatches on `$1`: given `sh` it skips initdb and the drop to
  // the postgres user, and Postgres refuses to run as root (seen live: exit 1, "must be started
  // under an unprivileged user ID").
  test(
    "postgres given compose's string command and string healthcheck starts healthy with that flag",
    async () => {
      const [service] = parseServicesYaml(
        [
          "services:",
          "  db:",
          "    image: postgres:16-alpine",
          "    environment:",
          "      POSTGRES_PASSWORD: crisol",
          "    command: postgres -c fsync=off",
          "    healthcheck:",
          // Over TCP: the entrypoint's init-time server listens on no address, only the real one does.
          "      test: pg_isready -h 127.0.0.1 -U postgres",
          "      interval: 1s",
          "      retries: 30",
          "",
        ].join("\n"),
        "services.yml",
      );
      const id = `strcmd-${crypto.randomUUID().slice(0, 8)}`;
      const network = `crisol-test-net-${id}`;
      expect(Bun.spawnSync(["docker", "network", "create", network]).exitCode).toBe(0);
      try {
        const services = await startServices(id, network, [service!]);
        try {
          await services.waitHealthy();
          const show = Bun.spawnSync(["docker", "exec", services.names[0]!, "psql", "-U", "postgres", "-tAc", "show fsync"]);
          expect(show.stdout.toString("utf8").trim()).toBe("off");
        } finally {
          await services.teardown();
        }
      } finally {
        Bun.spawnSync(["docker", "network", "rm", network]);
      }
    },
    90_000,
  );

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
    "behind the Allowlist wall, an HTTP Service is reachable by name with HTTP_PROXY set",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        // node:22-alpine carries Node for the server and busybox `wget` for the healthcheck,
        // both checked live in that image.
        writeServicesYaml(
          repo.path,
          [
            "services:",
            "  web:",
            "    image: node:22-alpine",
            `    command: ["node", "-e", "require('http').createServer((q, s) => s.end('svc-ok')).listen(8080)"]`,
            "    healthcheck:",
            '      test: ["CMD-SHELL", "wget -qO- http://localhost:8080/"]',
            "      interval: 1s",
            "      timeout: 2s",
            "      retries: 30",
            "",
          ].join("\n"),
        );

        const gate = 'test -n "$HTTP_PROXY" && curl -fsS --max-time 10 http://web:8080/ | grep -q svc-ok';
        const result = await run({ task: "reach the web service", cwd: repo.path, home: home.path, gates: [gate] });

        expect(result.network).toBe("allowlist");
        expect(result.gates).toEqual([{ cmd: gate, ok: true }]);
        expect(result.status).toBe("verified");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "a Service that exits before it is healthy fails the Run within seconds, with its exit code and last log lines",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        // A 30s interval keeps the healthcheck itself from settling anything within this test:
        // only noticing the exit can end the wait this early.
        writeServicesYaml(
          repo.path,
          [
            "services:",
            "  broken:",
            "    image: alpine:3.20",
            '    command: ["sh", "-c", "echo starting broken; echo missing DATABASE_URL >&2; exit 1"]',
            "    healthcheck:",
            '      test: ["CMD-SHELL", "exit 1"]',
            "      interval: 30s",
            "      retries: 10",
            "",
          ].join("\n"),
        );

        const startedAt = Date.now();
        const failure = await run({ task: "never reached", cwd: repo.path, home: home.path }).then(
          () => undefined,
          (error: unknown) => error,
        );
        const elapsedMs = Date.now() - startedAt;

        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain('"broken"');
        expect(message).toContain("exited with code 1");
        expect(message).toContain("starting broken");
        expect(message).toContain("missing DATABASE_URL");
        expect(elapsedMs).toBeLessThan(30_000);

        const [runId] = readdirSync(path.join(home.path, "runs"));
        const result = JSON.parse(readFileSync(path.join(home.path, "runs", runId!, "result.json"), "utf8")) as RunResult;
        expect(result.iterations).toBe(0);
        expect(result.reason).toContain("exited with code 1");
        expect(dockerInspect(`crisol-svc-${runId}-broken`)).toBeUndefined();
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
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
