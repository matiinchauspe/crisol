import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TokenObtainer } from "../src/auth";
import { extractToken, relayRedactedAndCapture, runAuth } from "../src/auth";
import {
  CLAUDE_TOKEN_SECRET_NAME,
  buildKeychainGetArgs,
  buildKeychainSetInvocation,
} from "../src/secret-store";
import type { SecretStore } from "../src/secret-store";
import { FAKE_TOKEN, SETUP_TOKEN_OUTPUT_FIXTURE } from "./fixtures/setup-token-output";

/** Feeds `text` through a `ReadableStream`, split exactly where the test wants, so a chunk boundary mid-token is deterministic rather than left to the OS. */
function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i++;
    },
  });
}

/**
 * `runAuth` is `crisol auth`'s whole orchestration, tested entirely with fakes — the
 * real login Keychain and the real `claude setup-token` are never touched in this suite.
 */
function fakeObtainer(token: string): TokenObtainer {
  return { obtain: async () => token };
}

function failingObtainer(message: string): TokenObtainer {
  return {
    obtain: async () => {
      throw new Error(message);
    },
  };
}

describe("runAuth (crisol auth, ticket 08)", () => {
  test("stores the obtained token under CLAUDE_CODE_OAUTH_TOKEN", async () => {
    let stored: { name: string; value: string } | undefined;
    const secretStore: SecretStore = {
      get: () => undefined,
      set: (name, value) => {
        stored = { name, value };
      },
    };

    await runAuth({ secretStore, obtainer: fakeObtainer("tok-abc123") });

    expect(stored).toEqual({ name: CLAUDE_TOKEN_SECRET_NAME, value: "tok-abc123" });
  });

  test("trims surrounding whitespace from the obtained token before storing it", async () => {
    let stored: string | undefined;
    const secretStore: SecretStore = {
      get: () => undefined,
      set: (_name, value) => {
        stored = value;
      },
    };

    await runAuth({ secretStore, obtainer: fakeObtainer("  tok-abc123  \n") });

    expect(stored).toBe("tok-abc123");
  });

  test("an obtainer failure never reaches the SecretStore", async () => {
    let called = false;
    const secretStore: SecretStore = {
      get: () => undefined,
      set: () => {
        called = true;
      },
    };

    await expect(
      runAuth({ secretStore, obtainer: failingObtainer("claude setup-token failed") }),
    ).rejects.toThrow("claude setup-token failed");
    expect(called).toBe(false);
  });

  test("an empty token is refused and never stored", async () => {
    let called = false;
    const secretStore: SecretStore = {
      get: () => undefined,
      set: () => {
        called = true;
      },
    };

    await expect(runAuth({ secretStore, obtainer: fakeObtainer("   ") })).rejects.toThrow();
    expect(called).toBe(false);
  });
});

/** Fixture reconstructed from the real captured stdout of `claude setup-token` (see test/fixtures/setup-token-output.ts) — proves extraction against real UI noise, never the real CLI. */
describe("extractToken (the fix for symptom 1: the whole output is not the token)", () => {
  test("pulls exactly the one real token out of the full captured UI, ignoring the OAuth URL and the literal <token> placeholder", () => {
    expect(extractToken(SETUP_TOKEN_OUTPUT_FIXTURE)).toBe(FAKE_TOKEN);
  });

  test("throws, naming none of the candidates, when no token-shaped value is found", () => {
    expect(() => extractToken("just the banner and a URL, no token here")).toThrow(/no token-shaped/i);
  });

  test("throws, naming none of the candidates, when two DISTINCT token-shaped values are found", () => {
    const output = "sk-ant-AAAAAAAAAA and later sk-ant-BBBBBBBBBB";
    let thrown: Error | undefined;
    try {
      extractToken(output);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toMatch(/2 distinct token-shaped values/);
    expect(thrown?.message).not.toContain("sk-ant-AAAAAAAAAA");
    expect(thrown?.message).not.toContain("sk-ant-BBBBBBBBBB");
  });

  test("the SAME token repeated twice (e.g. a redrawn success screen) is not an ambiguity", () => {
    expect(extractToken(`${SETUP_TOKEN_OUTPUT_FIXTURE}\n${FAKE_TOKEN}`)).toBe(FAKE_TOKEN);
  });
});

describe("relayRedactedAndCapture (the fix for symptom 2: the human must see the sign-in flow — without ever seeing the token)", () => {
  test("captures the full fixture unredacted, for extractToken, while relaying a version with the token replaced", async () => {
    const relayed: string[] = [];
    const captured = await relayRedactedAndCapture(chunkedStream([SETUP_TOKEN_OUTPUT_FIXTURE]), (text) =>
      relayed.push(text),
    );

    expect(captured).toBe(SETUP_TOKEN_OUTPUT_FIXTURE);
    expect(relayed.join("")).not.toContain(FAKE_TOKEN);
    expect(relayed.join("")).toContain("[REDACTED]");
    // Everything ELSE a human needs to see — the URL, the paste prompt — still reaches them.
    expect(relayed.join("")).toContain("Browser didn't open?");
    expect(relayed.join("")).toContain("Paste code here if prompted");
  });

  test("a token deliberately split across two reads is still fully redacted, never partially relayed", async () => {
    const relayed: string[] = [];
    const captured = await relayRedactedAndCapture(
      chunkedStream(["before sk-ant-ABC", "DEFGHIJKLMNOP after\n"]),
      (text) => relayed.push(text),
    );

    expect(captured).toBe("before sk-ant-ABCDEFGHIJKLMNOP after\n");
    const relayedText = relayed.join("");
    expect(relayedText).not.toContain("sk-ant-");
    expect(relayedText).toBe("before [REDACTED] after\n");
  });

  test("text with no trailing newline (the human-must-answer-a-prompt case) still flushes immediately, not only at stream end", async () => {
    const relayed: string[] = [];
    let resolveSecondChunk!: () => void;
    const secondChunkReady = new Promise<void>((resolve) => {
      resolveSecondChunk = resolve;
    });
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pullCount++;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode("Paste code here if prompted >"));
          return;
        }
        await secondChunkReady;
        controller.enqueue(new TextEncoder().encode("done\n"));
        controller.close();
      },
    });

    const relayPromise = relayRedactedAndCapture(stream, (text) => relayed.push(text));
    // Give the first chunk every chance to be relayed before the second one ever arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(relayed.join("")).toBe("Paste code here if prompted >");

    resolveSecondChunk();
    await relayPromise;
  });

  test("ordinary text ending in a letter that could start 'sk-ant-' is not mistaken for a token", async () => {
    const relayed: string[] = [];
    const captured = await relayRedactedAndCapture(
      chunkedStream(["this ends in s", " and continues\n"]),
      (text) => relayed.push(text),
    );

    expect(captured).toBe("this ends in s and continues\n");
    expect(relayed.join("")).toBe("this ends in s and continues\n");
    expect(relayed.join("")).not.toContain("[REDACTED]");
  });
});

describe("buildKeychainSetInvocation never puts the secret's VALUE on any argv (pure function, no `security` call)", () => {
  const adversarialValues = [
    "tok-abc123",
    "-U",
    "-w",
    "--help",
    "value with spaces",
    'value "with" quotes',
    "value\\with\\backslashes",
    "value$with`shell(chars);and&more",
    "crisol",
    "a".repeat(500),
  ];

  for (const value of adversarialValues) {
    test(`args stays exactly ["security", "-i"] for value ${JSON.stringify(value)}`, () => {
      const { args } = buildKeychainSetInvocation("CLAUDE_CODE_OAUTH_TOKEN", value);
      expect(args).toEqual(["security", "-i"]);
      expect(args.join(" ")).not.toContain(value);
    });
  }

  test("a keychain path (test-only parameter) is also never the secret, and never appears in args either", () => {
    const { args } = buildKeychainSetInvocation("NAME", "the-secret-value", "/tmp/some.keychain-db");
    expect(args).toEqual(["security", "-i"]);
  });

  test("the value DOES travel through stdin, as one escaped line for security's own interactive shell", () => {
    const { stdin } = buildKeychainSetInvocation("CLAUDE_CODE_OAUTH_TOKEN", "tok-abc123");
    const command = new TextDecoder().decode(stdin);
    expect(command).toBe('add-generic-password -a "CLAUDE_CODE_OAUTH_TOKEN" -s "crisol" -w "tok-abc123" -U\n');
  });

  test("a value containing a quote and a backslash is escaped for security's own tokenizer", () => {
    const { stdin } = buildKeychainSetInvocation("NAME", 'has "quotes" and \\backslash');
    const command = new TextDecoder().decode(stdin);
    expect(command).toContain('-w "has \\"quotes\\" and \\\\backslash" -U');
  });

  test("a value containing a newline is refused before any invocation is built", () => {
    expect(() => buildKeychainSetInvocation("NAME", "line1\nline2")).toThrow(/newline/);
  });

  test("a value containing a NUL byte is refused before any invocation is built", () => {
    expect(() => buildKeychainSetInvocation("NAME", "a\0b")).toThrow(/NUL/);
  });
});

describe("buildKeychainGetArgs never carries a value — there is nothing to keep off this argv", () => {
  test("reads the account/service pair, password only", () => {
    const args = buildKeychainGetArgs("CLAUDE_CODE_OAUTH_TOKEN");
    expect(args).toEqual([
      "security",
      "find-generic-password",
      "-a",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "-s",
      "crisol",
      "-w",
    ]);
  });
});

/** Proof against the REAL `security` CLI, on a throwaway keychain created and destroyed here — never the real login Keychain. */
describe("the real `security` CLI never shows the secret in its own argv (throwaway keychain)", () => {
  test("a live `security -i` process's argv, snapshotted via ps WHILE it still holds the value in flight, never contains it — and the value still round-trips correctly", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crisol-keychain-probe-"));
    const keychainPath = path.join(dir, "probe.keychain-db");
    const name = "CRISOL_TEST_ARGV_PROBE";
    const value = "LIVE_ARGV_PROBE_SECRET_VALUE_zzz_12345";
    try {
      const create = Bun.spawnSync(
        ["security", "create-keychain", "-p", crypto.randomUUID(), keychainPath],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(create.exitCode).toBe(0);

      const { args, stdin } = buildKeychainSetInvocation(name, value, keychainPath);
      const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      proc.stdin.write(stdin);
      await proc.stdin.flush();

      // The process is still alive (stdin not yet closed) — its argv, fixed at spawn
      // time, is exactly what a real attacker's `ps` would see for the whole lifetime
      // of this command.
      const psWhileAlive = Bun.spawnSync(["ps", "-p", String(proc.pid), "-o", "command="], {
        stdout: "pipe",
      }).stdout.toString("utf8");
      expect(psWhileAlive).not.toContain(value);
      expect(psWhileAlive.trim()).toBe("security -i");

      proc.stdin.end();
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);

      const getArgs = buildKeychainGetArgs(name, keychainPath);
      const getResult = Bun.spawnSync(getArgs, { stdout: "pipe", stderr: "pipe" });
      expect(getResult.exitCode).toBe(0);
      expect(getResult.stdout.toString("utf8").trim()).toBe(value);
    } finally {
      Bun.spawnSync(["security", "delete-keychain", keychainPath], { stdout: "ignore", stderr: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
