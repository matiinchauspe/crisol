import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  addToRepoAllowlist,
  addToUserAllowlist,
  hostsToLearn,
  allowlistByLevel,
  learnBaseline,
  mergedAllowlist,
  parseAllowlistFile,
  repoLevelChangeWarning,
} from "../src/allowlist";
import { BUILT_IN_ALLOWLIST } from "../src/network";
import { createTempHome } from "./support/crisolHome";
import { createFixtureRepo } from "./support/fixtureRepo";

function repoLevel(repoPath: string): string {
  return path.join(repoPath, ".crisol", "network");
}

function writeRepoLevel(repoPath: string, text: string): void {
  mkdirSync(path.join(repoPath, ".crisol"), { recursive: true });
  writeFileSync(repoLevel(repoPath), text);
}

describe("parseAllowlistFile reads either level: one host per line", () => {
  test("skips blank lines and # comments, and lowercases each host", () => {
    expect(parseAllowlistFile("# mine\napi.Stripe.com\n\n  sentry.io  \n", "/x/network")).toEqual([
      "api.stripe.com",
      "sentry.io",
    ]);
  });

  test("an inline `# comment` after a host is stripped", () => {
    expect(parseAllowlistFile("api.stripe.com # stripe\nsentry.io#errors\n", "/x/network")).toEqual([
      "api.stripe.com",
      "sentry.io",
    ]);
  });

  test("CRLF line endings, a leading BOM and a missing final newline all parse", () => {
    expect(parseAllowlistFile("\uFEFFapi.stripe.com\r\nsentry.io # errors\r\nexample.org", "/x/network")).toEqual([
      "api.stripe.com",
      "sentry.io",
      "example.org",
    ]);
  });

  test.each([
    "host.docker.internal",
    "gateway.docker.internal",
    "metadata.google.internal",
    "kubernetes.default.svc",
    "api.default.svc.cluster.local",
    "printer.local",
    "localhost.localdomain",
    "app.localhost",
    "router.lan",
    "nas.home",
    "wiki.corp",
    "1.0.0.127.in-addr.arpa",
  ])("%p names a host inside the machine or network, so the file is rejected naming it", (host) => {
    expect(() => parseAllowlistFile(`${host}\n`, "/x/network")).toThrow(JSON.stringify(host));
    expect(() => parseAllowlistFile(`${host}\n`, "/x/network")).toThrow(/inside/);
  });

  test.each(["a$(id)b.com", "1.2.3.4", "*.example.com", "example.com:8080", "localhost"])(
    "%p is not a plain hostname, so the file is rejected naming it",
    (host) => {
      expect(() => parseAllowlistFile(`${host}\n`, "/x/network")).toThrow(/\/x\/network/);
      expect(() => parseAllowlistFile(`${host}\n`, "/x/network")).toThrow(JSON.stringify(host));
    },
  );
});

describe("the built-in level", () => {
  test("lets a yarn repo install: Yarn 1's registry and the host Corepack fetches Yarn 2+ from", () => {
    // Both hosts from Corepack's own config.json (github.com/nodejs/corepack), definitions.yarn.ranges.
    expect(BUILT_IN_ALLOWLIST).toContain("registry.yarnpkg.com");
    expect(BUILT_IN_ALLOWLIST).toContain("repo.yarnpkg.com");
  });
});

describe("mergedAllowlist merges built-in, user and repo levels", () => {
  test("every level contributes, with no duplicates", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "network"), "api.stripe.com\ngithub.com\n");
      writeRepoLevel(repo.path, "sentry.io # errors\napi.stripe.com\n");
      const merged = mergedAllowlist(home.path, repo.path);
      for (const host of BUILT_IN_ALLOWLIST) expect(merged).toContain(host);
      expect(merged).toContain("api.stripe.com");
      expect(merged).toContain("sentry.io");
      expect(merged.filter((host) => host === "api.stripe.com")).toHaveLength(1);
      expect(merged.filter((host) => host === "github.com")).toHaveLength(1);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("no user file and no repo file is the built-in level alone", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      expect(mergedAllowlist(home.path, repo.path)).toEqual([...BUILT_IN_ALLOWLIST]);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("a repo host that is not a plain hostname fails, naming the file and the host", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeRepoLevel(repo.path, "a$(id)b.com\n");
      expect(() => mergedAllowlist(home.path, repo.path)).toThrow(/\.crisol\/network.*"a\$\(id\)b\.com"/);
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });

  test("`network` in .crisol/config.toml is not a level", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      mkdirSync(path.join(repo.path, ".crisol"), { recursive: true });
      writeFileSync(path.join(repo.path, ".crisol", "config.toml"), 'network = ["sentry.io"]\n');
      expect(mergedAllowlist(home.path, repo.path)).not.toContain("sentry.io");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("addToUserAllowlist appends to ~/.crisol/network", () => {
  test("creates the file, appends, and reports a host already there", () => {
    const home = createTempHome();
    try {
      expect(addToUserAllowlist(home.path, "API.stripe.com").outcome).toBe("added");
      expect(addToUserAllowlist(home.path, "sentry.io").outcome).toBe("added");
      expect(addToUserAllowlist(home.path, "api.stripe.com").outcome).toBe("already");
      expect(readFileSync(path.join(home.path, "network"), "utf8")).toBe("api.stripe.com\nsentry.io\n");
    } finally {
      home.cleanup();
    }
  });

  test("an internal name is refused and nothing is written", () => {
    const home = createTempHome();
    try {
      expect(() => addToUserAllowlist(home.path, "host.docker.internal")).toThrow(/inside/);
      expect(existsSync(path.join(home.path, "network"))).toBe(false);
    } finally {
      home.cleanup();
    }
  });

  test("a built-in host is reported, never written", () => {
    const home = createTempHome();
    try {
      expect(addToUserAllowlist(home.path, "github.com").outcome).toBe("built-in");
      expect(existsSync(path.join(home.path, "network"))).toBe(false);
    } finally {
      home.cleanup();
    }
  });

  test.each(["a$(id)b.com", "1.2.3.4", "-x.com"])("%p is refused and nothing is written", (host) => {
    const home = createTempHome();
    try {
      expect(() => addToUserAllowlist(home.path, host)).toThrow(JSON.stringify(host));
      expect(existsSync(path.join(home.path, "network"))).toBe(false);
    } finally {
      home.cleanup();
    }
  });
});

describe("addToRepoAllowlist appends to .crisol/network", () => {
  test("creates .crisol/ and the file when the repo has neither", () => {
    const repo = createFixtureRepo();
    try {
      expect(addToRepoAllowlist(repo.path, "sentry.io").outcome).toBe("added");
      expect(readFileSync(repoLevel(repo.path), "utf8")).toBe("sentry.io\n");
    } finally {
      repo.cleanup();
    }
  });

  test("appends a line and leaves every existing line, comments included, byte for byte", () => {
    const repo = createFixtureRepo();
    try {
      const before = "# payments\napi.stripe.com   # stripe\n\nsentry.io";
      writeRepoLevel(repo.path, before);
      expect(addToRepoAllowlist(repo.path, "Example.org").outcome).toBe("added");
      expect(readFileSync(repoLevel(repo.path), "utf8")).toBe(`${before}\nexample.org\n`);
    } finally {
      repo.cleanup();
    }
  });

  test("a host already on the repo level, or built in, is not written", () => {
    const repo = createFixtureRepo();
    try {
      writeRepoLevel(repo.path, "sentry.io # errors\n");
      expect(addToRepoAllowlist(repo.path, "sentry.io").outcome).toBe("already");
      expect(addToRepoAllowlist(repo.path, "github.com").outcome).toBe("built-in");
      expect(readFileSync(repoLevel(repo.path), "utf8")).toBe("sentry.io # errors\n");
    } finally {
      repo.cleanup();
    }
  });

  test("an invalid host is refused before anything is created", () => {
    const repo = createFixtureRepo();
    try {
      expect(() => addToRepoAllowlist(repo.path, "x; rm -rf ~ #")).toThrow(/plain hostname/);
      expect(existsSync(path.join(repo.path, ".crisol"))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});

describe("what a learn Run proposes", () => {
  test("hostsToLearn keeps plain hostnames on their scheme's own port, not in the baseline, deduplicated", () => {
    const reached = [
      { host: "registry.npmjs.org", count: 77 },
      { host: "api.stripe.com", count: 3 },
      { host: "github.com", port: 22, count: 1 },
      { host: "a$(id)b.com", count: 1 },
      { host: "1.2.3.4", count: 1 },
      { host: "sentry.io", count: 2 },
    ];
    expect(hostsToLearn(reached, BUILT_IN_ALLOWLIST)).toEqual(["api.stripe.com", "sentry.io"]);
  });

  test("an internal name an agent reached is never proposed", () => {
    const reached = [
      { host: "host.docker.internal", count: 1 },
      { host: "metadata.google.internal", count: 1 },
      { host: "kubernetes.default.svc", count: 1 },
      { host: "api.stripe.com", count: 1 },
    ];
    expect(hostsToLearn(reached, BUILT_IN_ALLOWLIST)).toEqual(["api.stripe.com"]);
  });

  test("the baseline is built-in plus the repo level: a host the user level allows is still missing from it", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "network"), "api.stripe.com\n");
      writeRepoLevel(repo.path, "sentry.io\n");
      expect(mergedAllowlist(home.path, repo.path)).toContain("api.stripe.com");
      const baseline = learnBaseline(repo.path);
      expect(baseline).toContain("sentry.io");
      expect(baseline).toContain("github.com");
      expect(baseline).not.toContain("api.stripe.com");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("allowlistByLevel says which level brought each host", () => {
  test("built-in first, then user, then repo; a host on two levels counts once, at the first", () => {
    const home = createTempHome();
    const repo = createFixtureRepo();
    try {
      writeFileSync(path.join(home.path, "network"), "api.stripe.com\n");
      writeRepoLevel(repo.path, "api.stripe.com\nsentry.io\ngithub.com\n");
      const entries = allowlistByLevel(home.path, parseAllowlistFile(readFileSync(repoLevel(repo.path), "utf8"), "network"));
      expect(entries.filter((entry) => entry.level !== "built-in")).toEqual([
        { host: "api.stripe.com", level: "user" },
        { host: "sentry.io", level: "repo" },
      ]);
      expect(entries.find((entry) => entry.host === "github.com")?.level).toBe("built-in");
    } finally {
      home.cleanup();
      repo.cleanup();
    }
  });
});

describe("repoLevelChangeWarning names what a branch adds to .crisol/network", () => {
  test("added lines are named quoted, comments and blank lines dropped", () => {
    const warning = repoLevelChangeWarning(["evil.example.com # needed", "", "# note", "a$(id)b.com"]);
    expect(warning).toContain(".crisol/network");
    expect(warning).toContain('"evil.example.com", "a$(id)b.com"');
    expect(warning).toContain("every later Run");
  });

  test("a change that adds no host still warns", () => {
    expect(repoLevelChangeWarning([])).toContain(".crisol/network");
  });
});
