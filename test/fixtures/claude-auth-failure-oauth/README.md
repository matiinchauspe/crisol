# A failed OAuth authentication, captured from the real `claude`

Captured by Matías on 2026-11-21, on the macOS host, from Claude Code 2.1.283
(`claude.version.txt`), by running the command in `oauth-invalid.command.txt` with a deliberately
invalid `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` unset. Every file here is the capture
byte for byte:

- `oauth-invalid.stdout.json` — stdout, the `--output-format json` result
- `oauth-invalid.stderr.txt` — stderr, empty
- `oauth-invalid.exit.txt` — the exit status, `exit=1`

Review round 1 over tickets 16..19 flagged that `claude-auth-failure/` only captured the
`ANTHROPIC_API_KEY` path, while the Sandbox authenticates with `CLAUDE_CODE_OAUTH_TOKEN`
(`secret-store.ts`'s `CLAUDE_TOKEN_SECRET_NAME`). This fixture is that missing path: same
`"is_error": true`, `"terminal_reason": "api_error"`, `"api_error_status": 401` shape, with
`"result": "Failed to authenticate. API Error: 401 OAuth access token is invalid."` in place of
the API-key capture's `"Invalid API key · Fix external API key"`. It classifies as `auth` by the
same rule ticket 19 built — `turnFailure` reads `is_error`/`terminal_reason`/`api_error_status`
alone, never the `result` text. Never edit these files by hand: a newer `claude` that reports this
differently needs a new capture.
