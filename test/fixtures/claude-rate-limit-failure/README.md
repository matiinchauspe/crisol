# A rate limit, built from a cited real report and the installed CLI's own strings (not a capture)

Cannot be provoked on demand, and the standing instruction for ticket 22 is never to spend real
retries trying. `rate-limit.stdout.json` is assembled, field by field, only from what a cited real
report and the locally installed `claude` binary show, never invented:

- **Structure and status** — [anthropics/claude-code#87692](https://github.com/anthropics/claude-code/issues/87692),
  Claude Code **2.1.234**: "Three more runs the same day died with `"api_error_status":429`,
  `"terminal_reason":"api_error"` — a rate-limit". The same issue shows the general envelope shape
  for an adjacent 5xx case (`"subtype":"success"`, `exit 1`), which the ticket's own research
  already pinned as constant across every API error — `exit=1` and `subtype: "success"` here
  follow that, not this issue's 429 line alone, which gives only the two fields quoted above.
- **The `result` text** — confirmed present in the locally installed
  `@anthropic-ai/claude-code@2.1.283` binary (`strings` against
  `node_modules/@anthropic-ai/claude-code-darwin-arm64/claude`), not in #87692, which shows no
  message text for its 429 case. The binary builds the subscription-path message from a static
  string (` "Server is temporarily limiting requests (not your usage limit)"`, held in a
  variable the minified bundle names `VBn`) prefixed with the literal `"API Error"` (`va="API
  Error"`), in a template `` `${va}: ${xe} · ${Ee||Pe}` `` — `xe` is `VBn` on the subscription
  path Crisol's Sandbox uses (`CLAUDE_CODE_OAUTH_TOKEN`, never `ANTHROPIC_API_KEY`:
  `secret-store.ts`'s `CLAUDE_TOKEN_SECRET_NAME`), `VBn`'s sibling path — API-key auth — instead
  prefixes the literal `"Request rejected (429)"`. `Ee`/`Pe` (an optional reason suffix) are
  dropped here: no cited source gives one, so the fixture keeps only the static prefix, without a
  fabricated suffix.
- **The retry exhaustion this surfaces after** — also confirmed in the same binary: a function
  (`QMe`) resolves `CLAUDE_CODE_MAX_RETRIES` if set and non-negative, clamped to **15**
  (`IMe=15`), else a non-interactive (`-p`) default of **10** (`jTo=10`) — matching the ticket's
  own research. A rate limit surfaces as this `ProviderFailureError` only once those retries are
  exhausted, never on the first 429.

Not reproduced here: `session_id`, `duration_ms` and the rest of the real envelope's bookkeeping
fields are omitted rather than invented — no cited source gives their values for this failure,
and `turnFailure` reads none of them.

If a newer `claude` changes this wording or these fields, replace this fixture with a real
capture — this reconstruction exists only because ticket 22 could not get one.
