# A failed authentication, captured from the real `claude`

Captured by Matías on 2026-11-18, on the macOS host, from Claude Code 2.1.283
(`claude.version.txt`), by running the command in `auth.command.txt` with a deliberately invalid
API key. Every file here is the capture byte for byte:

- `auth.stdout.json` — stdout, the `--output-format json` result
- `auth.stderr.txt` — stderr, a connectors warning that says nothing about the failure
- `auth.exit.txt` — the exit status, `exit=1`

The output says `"subtype": "success"` and carries its cause only in `is_error`,
`terminal_reason` and `api_error_status`, so those are what the Adapter classifies on. Never edit
these files by hand: a newer `claude` that reports this differently needs a new capture.
