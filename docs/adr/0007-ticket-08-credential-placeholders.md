# Ticket 08's credential placeholders

A secret name from `PreStartDeclaration.envNames` (Adapter-declared) resolves its value from
`SecretStore`, keyed by that same name — never special-cased to one literal name, so a future
Adapter needs no change here. A repo-declared name (`.crisol/config.toml`'s `env = [...]`)
resolves from the host's own environment instead, per the spec.

## `.crisol/config.toml`'s `env` key reuses the `gates` array parser

`parseGatesArray` and the new `parseSecretNamesArray` both call a shared
`parseStringArrayKey(text, key)` — the same single-line, double-quoted-array parser ADR 0006
already accepted for `gates`, generalised to take the key name. A real TOML dependency is still
later work.

## `KeychainSecretStore.set` keeps the secret's value off every spawned process's argv

`security add-generic-password -w <password>` would put the value on `security`'s own argv —
visible to any process of the same user via `ps` for as long as that process runs. Checked
directly against the real binary rather than assumed: `security -i` (its interactive command
shell) accepts the same command over **stdin** instead, and a process's argv is fixed at spawn
time regardless of what it later reads from stdin. `buildKeychainSetInvocation` spawns `security
-i` with args always exactly `["security", "-i"]` and writes one escaped `add-generic-password`
line to its stdin; `test/auth.test.ts` proves this against the real CLI on a throwaway keychain,
snapshotting `ps` on the live process while the value is in flight.

`buildKeychainGetArgs` never carried a value to begin with — reading returns one via stdout, so
there was nothing to fix there.

Escaping for `security -i`'s own tokenizer (`\` and `"` are the only two characters it treats
specially inside a quoted token) was also verified against the real binary, not assumed from its
docs — including dollar signs, backticks, semicolons, and a leading dash, none of which it
shell-interprets since `security` parses its own command stream rather than handing it to a shell.

Rejected:
- **A lower-level Keychain Services call via `bun:ffi`** — removes a dependency on `security`'s
  own interactive-mode parsing, at an implementation cost this ticket doesn't need to pay once the
  stdin-based path above was found and verified to work.

## `claude setup-token`'s output is its whole interactive UI, not the token alone

The `$(claude setup-token)` "token alone on stdout" assumption this ADR originally made was
false: Matías's real capture (Claude Code v2.1.283) showed the WHOLE Ink UI on stdout — the
banner redrawn three times, an OSC 8 hyperlink wrapping the sign-in URL, the "Paste code here if
prompted" prompt, and finally the token — with escape sequences and no clean separation from
prompt text. Piping stdout and treating its trimmed contents as the token (the earlier design)
stored the entire blob, newlines and all, and failed outright once `security -i` rejected it; it
also hid the sign-in URL and paste prompt from the human entirely, since nothing relayed stdout
anywhere.

Fixed with two parts, both proven against real captured output or a real stream, never the real
`claude` CLI (forbidden for this ticket):

- `extractToken` pulls exactly one `sk-ant-[A-Za-z0-9_-]+` substring out of the full text, after
  the process exits. `test/fixtures/setup-token-output.ts` reconstructs Matías's real capture
  (fake token substituted) as a regression fixture; `extractToken` refuses to guess — throwing,
  naming no candidate — when that substring appears zero or more than once.
- `relayRedactedAndCapture` reads the child's stdout as it arrives and hands a human watching the
  real terminal everything AS SOON AS IT IS SAFE to — the sign-in URL and the paste prompt reach
  them with no artificial delay, even with no trailing newline — except any `sk-ant-...`
  substring, replaced by `[REDACTED]` before it ever reaches that relay, even one split across two
  reads. The unredacted text is still returned, for `extractToken` to search once the stream ends.
  `test/auth.test.ts` proves the split-token and no-newline-prompt cases against controlled
  streams.

A human must still run `crisol auth` for real once and confirm the token was stored — the exact
check: `security find-generic-password -a CLAUDE_CODE_OAUTH_TOKEN -s crisol -w` (prints the
stored value; never run this in a shared terminal or log it).

## `KeychainSecretStore.get` does not distinguish "no such entry" from any other `security` failure

A missing entry and a denied Keychain prompt both return `undefined`, surfacing the same "run
`crisol auth` first" message either way — a human seeing it either fixes a genuine miss or
notices the Keychain is denying Crisol, neither path silently wrong.
