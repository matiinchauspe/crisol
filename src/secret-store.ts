/**
 * The only seam between Crisol and the macOS Keychain — `run.ts` and `crisol auth` never
 * call `security` directly, so a test can substitute an in-memory store instead of
 * touching the real login Keychain.
 */
export interface SecretStore {
  /** `undefined` when the name has never been stored — never throws for a plain miss. */
  get(name: string): string | undefined;
  set(name: string, value: string): void;
}

/** The account `crisol auth` stores the Claude token under, and the name a real Adapter will declare in its `PreStartDeclaration.envNames`. */
export const CLAUDE_TOKEN_SECRET_NAME = "CLAUDE_CODE_OAUTH_TOKEN";

/** One Keychain entry per secret name, all under this one Crisol-owned service — never the user's own `login` keychain entries for other apps. */
const KEYCHAIN_SERVICE = "crisol";

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], stdin?: Uint8Array): ShellResult {
  const proc = Bun.spawnSync(args, { env: process.env, stdin, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString("utf8"),
    stderr: proc.stderr.toString("utf8"),
  };
}

/** Checked against the real binary: `\` and `"` are the only two characters `security -i`'s own tokenizer treats specially inside a quoted token. */
function escapeForSecurityInteractive(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface KeychainInvocation {
  args: string[];
  stdin: Uint8Array;
}

/**
 * Pure, so its shape is a unit test without ever calling `security`. `args` is always
 * `["security", "-i"]`; the value travels only through `stdin`, since `-w` itself has no
 * stdin-based mode but `security`'s own interactive shell does, and argv is fixed at
 * spawn time regardless of what a process later reads from stdin.
 */
export function buildKeychainSetInvocation(
  name: string,
  value: string,
  keychainPath?: string,
): KeychainInvocation {
  if (value.includes("\n") || value.includes("\0")) {
    throw new Error(
      `Could not store "${name}": its value contains a newline or NUL byte, which the ` +
        `one-line command sent to "security -i" can't carry.`,
    );
  }
  const target = keychainPath ? ` "${escapeForSecurityInteractive(keychainPath)}"` : "";
  const command =
    `add-generic-password -a "${escapeForSecurityInteractive(name)}" -s "${KEYCHAIN_SERVICE}" ` +
    `-w "${escapeForSecurityInteractive(value)}" -U${target}\n`;
  return { args: ["security", "-i"], stdin: new TextEncoder().encode(command) };
}

/** Never carries a value — a read returns one via stdout, so there is nothing to keep off this argv in the first place. */
export function buildKeychainGetArgs(name: string, keychainPath?: string): string[] {
  const args = ["security", "find-generic-password", "-a", name, "-s", KEYCHAIN_SERVICE, "-w"];
  return keychainPath ? [...args, keychainPath] : args;
}

/** v1's only `SecretStore` — real callers get this by default; tests always inject a fake instead. */
export class KeychainSecretStore implements SecretStore {
  get(name: string): string | undefined {
    const result = run(buildKeychainGetArgs(name));
    // `security` exits non-zero both for "no such entry" and for a denied Keychain
    // prompt; either way the caller's own message ("run `crisol auth` first") is the
    // right next step, so the two are not distinguished here.
    if (result.exitCode !== 0) return undefined;
    return result.stdout.trim();
  }

  set(name: string, value: string): void {
    const { args, stdin } = buildKeychainSetInvocation(name, value);
    const result = run(args, stdin);
    if (result.exitCode !== 0) {
      throw new Error(`Could not store "${name}" in the macOS Keychain: ${result.stderr.trim()}`);
    }
  }
}
