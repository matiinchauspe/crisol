# An exhausted subscription quota, built from cited real reports (not a capture)

Neither a rate limit nor an exhausted quota can be provoked on demand, and the standing
instruction for ticket 22 is never to spend real quota trying. Unlike `claude-auth-failure/` and
`claude-auth-failure-oauth/`, `quota.stdout.json` is not byte-for-byte output from a run — it is
assembled, field by field, only from what cited real reports show, never invented:

- **Structure and status** — [anthropics/claude-code#103807](https://github.com/anthropics/claude-code/issues/103807),
  Claude Code **2.1.304**, the exact invocation this repo uses
  (`claude -p --output-format json`, there with `--model`/`--effort` flags added): "A usage-limit
  rejection correctly exits 1 and sets `is_error: true`, `terminal_reason: api_error`, and HTTP
  status 429" — verbatim: `{"type":"result","subtype":"success","terminal_reason":"api_error","is_error":true,"api_error_status":429,"api_error":"usage_limit_reached"}`.
  `exit=1` and `terminal_reason`/`is_error`/`api_error_status` come from here.
- **The `result` text** — [anthropics/claude-code#57096](https://github.com/anthropics/claude-code/issues/57096),
  Claude Code **2.1.132**, a different occurrence of the same subscription-overage rejection. Its
  own `--output-format json` result line elides every field but `is_error`/`api_error_status`
  (`{"type":"result","subtype":"success","is_error":true,"api_error_status":429,…}`); the exact
  wording comes from the SAME turn's streamed assistant message instead:
  `"You're out of extra usage · resets 6:40pm (America/New_York)"`. `claude.version.txt` names
  2.1.304 (the structure's source), not 2.1.132, since that is the version this repo's exact
  invocation was confirmed against.
- **The prefix list this wording belongs to** — confirmed present in the locally installed
  `@anthropic-ai/claude-code@2.1.283` binary (`strings` against
  `node_modules/@anthropic-ai/claude-code-darwin-arm64/claude`): a literal array
  `["You've hit your","You've reached your","You're out of usage credits","Your org is out of
  usage · add funds to continue","Your org is out of usage · contact your admin", …]` feeds a
  `startsWith` check used elsewhere in the CLI. `turnFailure` (`src/adapters/claude-code.ts`)
  checks the same prefixes against `result` to tell a 429 quota rejection from a 429 rate limit.

Not reproduced here: `stderr` is left empty by analogy with every other capture, not because
either cited issue says so — neither shows stderr at all. `session_id`, `duration_ms` and the
rest of the real envelope's bookkeeping fields are omitted rather than invented: no cited source
gives their values for this failure, and `turnFailure` reads none of them.

If a newer `claude` changes this wording or these fields, replace this fixture with a real
capture — this reconstruction exists only because ticket 22 could not get one.
