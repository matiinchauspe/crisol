import { CLAUDE_TOKEN_SECRET_NAME, KeychainSecretStore } from "./secret-store";
import type { SecretStore } from "./secret-store";

/** `crisol auth`'s own seam for getting a token value — a test injects a scripted one instead of ever calling the real CLI. */
export interface TokenObtainer {
  obtain(): Promise<string>;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

const TOKEN_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

/** Every incremental prefix of "sk-ant-", plus that prefix extended by any run of token characters — what `splitSafeToFlush` holds back until more input resolves it. */
const TRAILING_POSSIBLE_TOKEN = /(?:s|sk|sk-|sk-a|sk-an|sk-ant|sk-ant-[A-Za-z0-9_-]*)$/;

/**
 * `claude setup-token`'s output carries its whole interactive UI — the token is one
 * `sk-ant-...` substring inside it, never the output as a whole. Refuses to guess
 * rather than store the wrong thing when that substring doesn't appear exactly once.
 */
export function extractToken(output: string): string {
  const matches = new Set(output.match(TOKEN_PATTERN) ?? []);
  if (matches.size === 0) {
    throw new Error("No token-shaped value was found in `claude setup-token`'s output.");
  }
  if (matches.size > 1) {
    throw new Error(
      `Found ${matches.size} distinct token-shaped values in \`claude setup-token\`'s output; refusing to guess which one is the real token.`,
    );
  }
  return [...matches][0]!;
}

/** The only text this module ever hands to a `write` callback — never the real token. */
function redactTokens(text: string): string {
  return text.replace(TOKEN_PATTERN, "[REDACTED]");
}

/** Everything before a trailing run that could still be an in-progress token is safe to flush now; that run itself is held back until more input resolves it. */
function splitSafeToFlush(text: string): { safe: string; pending: string } {
  const match = TRAILING_POSSIBLE_TOKEN.exec(text);
  if (!match) return { safe: text, pending: "" };
  return { safe: text.slice(0, match.index), pending: text.slice(match.index) };
}

/**
 * Reads a child's stdout as it arrives, handing `write` everything as soon as it's
 * safe to — a sign-in URL or a paste prompt reaches a human watching the real terminal
 * with no artificial delay even if the child never sends a trailing newline — except any
 * `sk-ant-...` substring, replaced by a placeholder before `write` ever sees it, even
 * one split across two reads. The full, UNREDACTED text is returned once the stream
 * ends, for `extractToken` to search afterward.
 */
export async function relayRedactedAndCapture(
  stream: ReadableStream<Uint8Array>,
  write: (text: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let captured = "";
  let pending = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    pending += decoder.decode(value, { stream: true });
    const split = splitSafeToFlush(pending);
    pending = split.pending;
    if (split.safe.length > 0) {
      captured += split.safe;
      write(redactTokens(split.safe));
    }
  }
  pending += decoder.decode();
  captured += pending;
  if (pending.length > 0) {
    write(redactTokens(pending));
  }
  return captured;
}

/**
 * Wraps `claude setup-token`. Stdin is inherited so the human can answer its prompts;
 * stdout is relayed live, redacted, to the real terminal — its sign-in URL and paste
 * prompt are otherwise invisible — and captured, unredacted, for `extractToken`.
 */
export class ClaudeSetupTokenObtainer implements TokenObtainer {
  async obtain(): Promise<string> {
    try {
      const proc = Bun.spawn(["claude", "setup-token"], {
        stdin: "inherit",
        stdout: "pipe",
        stderr: "inherit",
      });
      const output = await relayRedactedAndCapture(proc.stdout, (text) => process.stdout.write(text));
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new Error("`claude setup-token` did not complete successfully.");
      }
      return extractToken(output);
    } catch (error) {
      if (isEnoent(error)) {
        throw new Error(
          "The `claude` CLI was not found on PATH. Install Claude Code " +
            "(https://claude.com/claude-code) and try again.",
        );
      }
      throw error;
    }
  }
}

export interface AuthOptions {
  /** Test seam; default is the real Keychain. */
  secretStore?: SecretStore;
  /** Test seam; default wraps the real `claude setup-token`. */
  obtainer?: TokenObtainer;
}

/**
 * `crisol auth`: obtains the Claude token and stores it in Crisol's own Keychain entry,
 * behind `SecretStore`. The token's value is never logged or returned — only
 * `secretStore.set` ever sees it.
 */
export async function runAuth(options: AuthOptions = {}): Promise<void> {
  const obtainer = options.obtainer ?? new ClaudeSetupTokenObtainer();
  const secretStore = options.secretStore ?? new KeychainSecretStore();

  const token = (await obtainer.obtain()).trim();
  if (token.length === 0) {
    throw new Error("`claude setup-token` produced no token.");
  }
  secretStore.set(CLAUDE_TOKEN_SECRET_NAME, token);
}
