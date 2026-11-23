import { describe, expect, test } from "bun:test";
import { formatBlockedAdvice } from "../src/cli";
import { buildDockerRunArgs } from "../src/docker";
import {
  BUILT_IN_ALLOWLIST,
  buildProxyEnv,
  ensureProxyImage,
  parseBlockedHosts,
  parseReachedHosts,
  renderTinyproxyConf,
  renderTinyproxyFilter,
  startNetworkWall,
} from "../src/network";
import {
  DIRECT_EGRESS_SCRIPT,
  REACH_ALLOWED_HOST_ON_ANOTHER_PORT_SCRIPT,
  REACH_ALLOWED_HOST_SCRIPT,
  REACH_BLOCKED_HOST_SCRIPT,
} from "../src/adapters/fake";
import { FakeAdapter } from "../src/adapters/fake";
import { run } from "../src/run";
import { existsSync } from "node:fs";
import path from "node:path";
import { runCli } from "./support/cli";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

function gitShow(repoPath: string, ref: string, file: string): string {
  const proc = Bun.spawnSync(["git", "-C", repoPath, "show", `${ref}:${file}`], { stdout: "pipe" });
  return proc.stdout.toString("utf8").trim();
}

function dockerNetworkExists(name: string): boolean {
  const proc = Bun.spawnSync(["docker", "network", "ls", "--filter", `name=${name}`, "--format", "{{.Name}}"], {
    stdout: "pipe",
  });
  return proc.stdout.toString("utf8").split("\n").includes(name);
}

describe("the Allowlist filter and conf are pure, no Docker needed", () => {
  test("renderTinyproxyFilter pins each host, escaped, to CONNECT on 443 and plain HTTP on 80", () => {
    const filter = renderTinyproxyFilter(["pypi.org", "registry.npmjs.org"]);
    expect(filter).toBe(
      "^pypi\\.org:443$\n^http://pypi\\.org(:80)?/\n" +
        "^registry\\.npmjs\\.org:443$\n^http://registry\\.npmjs\\.org(:80)?/\n",
    );
  });

  test("renderTinyproxyFilter never emits a subdomain wildcard", () => {
    const filter = renderTinyproxyFilter(["github.com"]);
    expect(filter).not.toContain("(.*");
    expect(filter).not.toContain("*");
  });

  test("the built-in Allowlist names the Anthropic API and the package registries from the spec", () => {
    expect(BUILT_IN_ALLOWLIST).toContain("api.anthropic.com");
    expect(BUILT_IN_ALLOWLIST).toContain("registry.npmjs.org");
    expect(BUILT_IN_ALLOWLIST).toContain("github.com");
    expect(BUILT_IN_ALLOWLIST).toContain("pypi.org");
    expect(BUILT_IN_ALLOWLIST).toContain("release-assets.githubusercontent.com");
  });

  test("renderTinyproxyConf wires FilterDefaultDeny and the given client CIDR, no TLS interception", () => {
    const conf = renderTinyproxyConf("192.168.64.0/24");
    expect(conf).toContain("FilterDefaultDeny Yes");
    expect(conf).toContain("Allow 192.168.64.0/24");
    expect(conf).toContain("FilterType ere");
    expect(conf).not.toMatch(/cert|CAfile|Ssl/i);
  });

  test("a learn conf has no filter at all, and still only serves the internal subnet", () => {
    const conf = renderTinyproxyConf("192.168.64.0/24", "learn");
    expect(conf).not.toMatch(/Filter/);
    expect(conf).toContain("Allow 192.168.64.0/24");
  });

  test("renderTinyproxyConf filters whole URLs, so the port is part of every match", () => {
    const conf = renderTinyproxyConf("192.168.64.0/24");
    expect(conf).toContain("FilterURLs On");
    expect(conf).not.toContain("ConnectPort");
  });
});

describe("parseBlockedHosts reads tinyproxy's own log line, no Docker needed", () => {
  const CAPTURED_LOG = [
    'NOTICE    Nov 16 14:57:59.829 [6]: Proxying refused on filtered url "evil.example.org:443"',
    'NOTICE    Nov 16 14:57:59.835 [6]: Proxying refused on filtered url "http://evil.example.org/"',
    'NOTICE    Nov 16 14:57:58.391 [6]: Proxying refused on filtered url "http://EVIL.example.org:80/x"',
    'NOTICE    Nov 16 14:57:58.391 [6]: Proxying refused on filtered url "http://example.com:80@evil.example.org/"',
    'NOTICE    Nov 16 14:57:58.391 [6]: Proxying refused on filtered url "http://github.com:22/"',
    'NOTICE    Nov 16 14:57:59.840 [6]: Proxying refused on filtered url "github.com:22"',
    'NOTICE    Nov 16 14:57:59.846 [6]: Proxying refused on filtered url "github.com:80"',
    'CONNECT   Nov 16 14:57:58.400 [6]: Request (file descriptor 4): CONNECT github.com:443 HTTP/1.1',
  ].join("\n");

  test("counts per host, folding each scheme's own port into the bare host", () => {
    expect(parseBlockedHosts(CAPTURED_LOG)).toContainEqual({ host: "evil.example.org", count: 4 });
  });

  test("a refused port is its own entry, CONNECT and plain HTTP alike", () => {
    const blocked = parseBlockedHosts(CAPTURED_LOG);
    expect(blocked).toContainEqual({ host: "github.com", port: 22, count: 2 });
    expect(blocked).toContainEqual({ host: "github.com", port: 80, count: 1 });
    expect(blocked).toHaveLength(3);
  });

  test("an empty log yields no blocked hosts", () => {
    expect(parseBlockedHosts("")).toEqual([]);
  });
});

describe("parseReachedHosts reads what a learn proxy connected to, no Docker needed", () => {
  // Lines copied verbatim, a subset, from a real tinyproxy 1.11.2 with no filter on a real internal network.
  const CAPTURED_LOG = [
    "CONNECT   Nov 16 18:09:23.048 [6]: Request (file descriptor 4): CONNECT example.com:443 HTTP/1.1",
    "INFO      Nov 16 18:09:23.048 [6]: opensock: opening connection to example.com:443",
    'CONNECT   Nov 16 18:09:23.127 [6]: Established connection to host "example.com" using file descriptor 5.',
    "CONNECT   Nov 16 18:09:23.218 [6]: Request (file descriptor 4): GET http://example.com/ HTTP/1.1",
    'CONNECT   Nov 16 18:09:23.262 [6]: Established connection to host "example.com" using file descriptor 5.',
    "CONNECT   Nov 16 18:09:23.308 [6]: Request (file descriptor 4): CONNECT does-not-exist-xyz123.invalid:443 HTTP/1.1",
    "ERROR     Nov 16 18:09:23.509 [6]: opensock: Could not retrieve address info for does-not-exist-xyz123.invalid:443: Name does not resolve",
    "CONNECT   Nov 16 18:09:23.519 [6]: Request (file descriptor 4): GET http://github.com:22/ HTTP/1.1",
    'CONNECT   Nov 16 18:09:23.730 [6]: Established connection to host "github.com" using file descriptor 5.',
    "CONNECT   Nov 16 18:09:33.934 [6]: Request (file descriptor 6): CONNECT EXAMPLE.org:443 HTTP/1.1",
    'CONNECT   Nov 16 18:09:33.995 [6]: Established connection to host "EXAMPLE.org" using file descriptor 7.',
  ].join("\n");

  test("counts each request to a host the proxy connected to, folding the scheme's own port", () => {
    const reached = parseReachedHosts(CAPTURED_LOG);
    expect(reached).toContainEqual({ host: "example.com", count: 2 });
    expect(reached).toContainEqual({ host: "example.org", count: 1 });
    expect(reached).toContainEqual({ host: "github.com", port: 22, count: 1 });
    expect(reached).toHaveLength(3);
  });

  test("a request the proxy never connected anywhere was not reached", () => {
    expect(parseReachedHosts(CAPTURED_LOG).map((entry) => entry.host)).not.toContain(
      "does-not-exist-xyz123.invalid",
    );
  });

  test("only tinyproxy's own CONNECT-category line counts as a connection, never text inside another", () => {
    const forged = [
      "CONNECT   Nov 16 18:09:23.048 [6]: Request (file descriptor 4): CONNECT forged.example.com:443 HTTP/1.1",
      'INFO      Nov 16 18:09:23.049 [6]: No upstream proxy for x Established connection to host "forged.example.com" using file descriptor 5.',
      'CONNECT   Nov 16 18:09:23.050 [6]: Request (file descriptor 4): GET http://a/Established connection to host "forged.example.com" using file descriptor 5. HTTP/1.1',
    ].join("\n");
    expect(parseReachedHosts(forged)).toEqual([]);
  });
});

describe("formatBlockedAdvice", () => {
  test("a refused port gets no `crisol allow` line — the Allowlist names hosts, never ports", () => {
    const advice = formatBlockedAdvice([{ host: "github.com", port: 22, count: 1 }], BUILT_IN_ALLOWLIST);
    expect(advice).toContain("github.com:22");
    expect(advice).not.toContain("crisol allow");
  });

  test("a plain hostname gets both allow lines, user level and repo level", () => {
    const advice = formatBlockedAdvice([{ host: "api.stripe.com", count: 3 }], BUILT_IN_ALLOWLIST);
    expect(advice).toContain("  crisol allow api.stripe.com\n  crisol allow api.stripe.com --repo");
    expect(advice).not.toContain("not built yet");
  });

  test.each(["a$(id)b.com", "x`id`y.com", "a;id;b.com", "a b.com", "1.2.3.4", "[::1]", "localhost"])(
    "%p is reported quoted, with no command to paste",
    (host) => {
      const advice = formatBlockedAdvice([{ host, count: 1 }], BUILT_IN_ALLOWLIST);
      expect(advice).not.toContain("crisol allow");
      expect(advice).toContain(JSON.stringify(host));
    },
  );

  test("an internal name gets no allow line: the Allowlist never opens the machine or the LAN", () => {
    const advice = formatBlockedAdvice([{ host: "host.docker.internal", count: 1 }], BUILT_IN_ALLOWLIST);
    expect(advice).toContain("host.docker.internal");
    expect(advice).not.toContain("crisol allow");
  });

  test("a metacharacter host refused on another port is quoted too", () => {
    const advice = formatBlockedAdvice([{ host: "a$(id)b.com", port: 22, count: 1 }], BUILT_IN_ALLOWLIST);
    expect(advice).toContain('"a$(id)b.com":22');
  });

  test("a host on the user or repo level gets no allow line either", () => {
    const advice = formatBlockedAdvice([{ host: "api.stripe.com", count: 1 }], [...BUILT_IN_ALLOWLIST, "api.stripe.com"]);
    expect(advice).not.toContain("crisol allow");
    expect(advice).toContain("already on the Allowlist");
  });

  test("a host already on the Allowlist gets no allow line: its request was refused for its form", () => {
    const advice = formatBlockedAdvice([{ host: "github.com", count: 2 }], BUILT_IN_ALLOWLIST);
    expect(advice).not.toContain("crisol allow");
    expect(advice).toContain("already on the Allowlist");
  });
});

describe("buildProxyEnv sets both casings tinyproxy's clients actually read", () => {
  test("curl reads lowercase http_proxy; everything else reads the uppercase names", () => {
    const env = buildProxyEnv("crisol-proxy-abc123");
    expect(env.HTTP_PROXY).toBe("http://crisol-proxy-abc123:8888");
    expect(env.http_proxy).toBe("http://crisol-proxy-abc123:8888");
    expect(env.HTTPS_PROXY).toBe("http://crisol-proxy-abc123:8888");
    expect(env.https_proxy).toBe("http://crisol-proxy-abc123:8888");
    expect(env.NO_PROXY).toBe(env.no_proxy);
  });
});

describe("buildDockerRunArgs attaches the Sandbox to the Allowlist wall's network", () => {
  test("--network is added right after --pull never when given", () => {
    const args = buildDockerRunArgs({
      image: "crisol-base:test",
      mountPath: "/tmp/x",
      env: {},
      id: "nettest",
      network: "crisol-net-nettest",
    });
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("crisol-net-nettest");
  });

  test("omitted entirely, the Sandbox keeps the default bridge", () => {
    const args = buildDockerRunArgs({ image: "crisol-base:test", mountPath: "/tmp/x", env: {}, id: "nonettest" });
    expect(args).not.toContain("--network");
  });
});

describe("ensureProxyImage runs before any side effect", () => {
  test("a proxy-image failure leaves no run directory, no Clone, and no branch behind", async () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      await expect(
        run({
          task: "x",
          cwd: repo.path,
          home: home.path,
          ensureProxyImage: async () => {
            throw new Error("simulated offline proxy-image build failure");
          },
        }),
      ).rejects.toThrow("simulated offline proxy-image build failure");

      expect(existsSync(path.join(home.path, "runs"))).toBe(false);
      expect(Bun.spawnSync(["git", "-C", repo.path, "branch", "--list", "crisol/*"]).stdout.toString()).toBe("");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("startNetworkWall fails closed when the internal network's subnet cannot be read", () => {
  test(
    "throws instead of widening Allow, and removes the network it already created",
    async () => {
      const image = await ensureProxyImage();
      const home = createTempHome();
      const id = `wallfail${Date.now()}`;
      try {
        await expect(startNetworkWall(id, home.path, image, { mode: "allowlist", hosts: [] }, () => undefined)).rejects.toThrow(/subnet/i);
        expect(dockerNetworkExists(`crisol-net-${id}`)).toBe(false);
      } finally {
        home.cleanup();
      }
    },
    30_000,
  );
});

describe("the Allowlist wall end to end, against a real Docker engine", () => {
  test(
    "a built-in allowlisted host is reachable from inside the Sandbox",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({
          task: "reach an allowlisted host",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(REACH_ALLOWED_HOST_SCRIPT),
        });
        expect(result.status).toBe("unverified");
        expect(result.network).toBe("allowlist");
        expect(gitShow(repo.path, result.branch, "ALLOWED.txt")).toBe("reached an allowlisted host");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "a non-listed host is blocked and appears in `blocked` with its attempt count",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({
          task: "attempt a blocked host",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(REACH_BLOCKED_HOST_SCRIPT),
        });
        expect(result.status).toBe("unverified");
        expect(result.network).toBe("allowlist");
        expect(result.blocked).toEqual([{ host: "example.com", count: 2 }]);
        expect(gitShow(repo.path, result.branch, "BLOCKED.txt")).toBe("attempted a blocked host twice");

        const advice = formatBlockedAdvice(result.blocked, BUILT_IN_ALLOWLIST);
        expect(advice).toContain("example.com");
        expect(advice).toContain("crisol allow example.com");
        expect(advice).toContain("crisol allow example.com --repo");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "an allowlisted host on another port is refused, over plain HTTP and CONNECT alike",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({
          task: "reach an allowlisted host on another port",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(REACH_ALLOWED_HOST_ON_ANOTHER_PORT_SCRIPT),
        });
        expect(gitShow(repo.path, result.branch, "PORT.txt")).toBe("403\n403");
        expect(result.blocked).toEqual([{ host: "github.com", port: 22, count: 2 }]);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "the plain-text end-of-run report names a blocked host and its `crisol allow` lines",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const cli = await runCli(
          ["run", "say hello", "--gate", "curl -sS --max-time 20 -o /dev/null https://example.com/ || true", "--adapter", "fake"],
          { cwd: repo.path, home: home.path },
        );
        expect(cli.exitCode).toBe(0);
        expect(cli.stdout).toContain(
          "Blocked: example.com (1 attempt). Allow it for every repo, or for this repo only, with:\n" +
            "  crisol allow example.com\n" +
            "  crisol allow example.com --repo",
        );
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "direct egress that bypasses the proxy fails — the Sandbox's network is --internal",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({
          task: "bypass the proxy",
          cwd: repo.path,
          home: home.path,
          adapter: new FakeAdapter(DIRECT_EGRESS_SCRIPT),
        });
        expect(result.status).toBe("unverified");
        expect(gitShow(repo.path, result.branch, "DIRECT.txt")).toBe("hostname BLOCKED\nip-literal BLOCKED");
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );

  test(
    "every Run's result carries network: \"allowlist\" by default",
    async () => {
      const home = createTempHome();
      const repo = createFixtureRepo();
      try {
        const result = await run({ task: "say hello", cwd: repo.path, home: home.path });
        expect(result.network).toBe("allowlist");
        expect(dockerNetworkExists(`crisol-net-${result.run}`)).toBe(false);
      } finally {
        home.cleanup();
        repo.cleanup();
      }
    },
    60_000,
  );
});
