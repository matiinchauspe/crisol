# The Sandbox writes Tenaza sessions only through a per-Run sink the host relays

Ticket 42, from the review of the 0.1.0 deliverable. Amends ADR 0028, which mounted the host's
Tenaza `state/` read-write into the Sandbox. That mount let the agent write what the host's Tenaza
acts on:

- `state/human.jsonl`, which every host hook polls for answers. A forged `live.answered` approves a
  reserved action held in any other session on the host. `daemon.alive` beside it fakes a running
  daemon.
- `state/sessions/*.jsonl`, the rows `tenaza run` executes. It runs `row.action.command` through
  `$SHELL -lc` on the host, in the cwd the row's session started in. The Clone sits at the same
  path on the host, so approving a reserved `git push` from the Inbox ran on the host, with the
  host's credentials, in a `.git` the agent wrote, or ran a command the agent rewrote.

All Tenaza facts below are from its repo at tag v0.5.2 (a2430fe), the version Crisol pins.

## What the Sandbox mounts

- `config/` read-only, as before.
- `state/` read-only. The hook still reads answers through it (`waitForLiveAnswer` →
  `readHumanEventsTolerant(human.jsonl)`, `src/live.ts:48-110`) and the heartbeat
  (`readAlive(daemon.alive)`, `src/decide.ts:177`). A `daemon.alive` the host daemon replaces by
  rename is still read fresh through the mount (verified live, 2026-11-24).
- `state/relay-requested/` read-write. The hook cannot notify from inside Linux, so it leaves a
  marker there and the host daemon notifies from it (`src/notify.ts:327-331,379`).
- `state/sessions/` is shadowed by a per-Run dir, `<runDir>/tenaza-sessions`, mounted read-write.
  The hooks write only by `appendFileSync` and `writeFileSync`, never by rename, so a nested mount
  catches every write.

A Continuation mounts the same sink, so its line numbers keep matching what the host already holds.

## The host relays the sink, line for line

`PreStartDeclaration` gains `eventSink`: a container path and a `start` the Run calls once the
Sandbox is up. `stop` runs after teardown, the ceiling path included, and makes one last pass. For
the Claude Code Adapter with Tenaza present, `start` is `startTenazaRelay`, a pass every 250 ms
over `relayTenazaSessions` (`src/tenaza.ts`).

A pass adopts each session file in the sink whose name is a plain id, recording it in
`<runDir>/tenaza-relayed`. A session the host already holds before adoption is refused. For each
owned session, it appends to the host's `state/sessions/<id>.jsonl` the whole lines it has not
copied yet. The count copied is the host file's own line count, so the pass is stateless. Blank
lines cross as they are, because an Inbox id is `sha1(session + "\n" + line)` over the line
numbers of non-blank lines (`src/identity.ts:17`, `src/log.ts:60-80,116-131`). A live answer
must find the same item on the host as the hook saw in the Sandbox.

Every other line must be a hook's event:

- JSON, an object, and naming the file's own session. `tenaza run` takes the session from the
  line, not the file name (`src/resolve.ts:93-106,192-193`, `src/sessions.ts:125-127`).
- One of the types the hooks write: `session.started`, `session.labeled`, `action.decided`,
  `usage.sampled`, `session.ended`, `prompt.submitted`, `notification.observed`, `turn.ended`.
  `live.answered` and the rest are the host's.
- A `session.started` whose `cwd` is inside the Clone.
- Any `parent` naming a session this Run owns. Subagents get their own session, parented to the
  agent's (`src/adapters/claude.ts:352,509-523`).

`terminal`, `pid` and `pidStartedAt` are dropped, since they name the Sandbox's terminal and
process. Rewriting the content keeps the row's identity, which is (session, line). The first line
that fails stops that session's relay for good, and the Run log says `Tenaza: stopped relaying
session <id>: <reason>`, once.

## What is still owed, and what stays open

- **Tenaza must not run a Sandbox's row on the host.** The agent still writes its own session's
  rows, and Tenaza's `tenaza run` would execute an approved one on the host. Owed to the tenaza
  repo, not this one: `tenaza run` must refuse host-side execution for a session whose cwd is under
  `~/.crisol/runs/`. The relay pins every relayed session's `cwd` to the Clone, so that check is
  sound.
- The agent still controls the content of its own session's rows, within the checks above.
- `relay-requested/` stays writable, so the agent can make the daemon notify.
- SessionStart prints `Tenaza self-check failed: the state directory is not writable` into the
  agent's context. It only warns (`src/health.ts:71-82`), and failed writes to `health.json` and
  `policy.lkg.json` are caught (`src/health.ts:30-36`, `src/policy.ts:134-150`).
- The sidecars (`.labels`, `.touched`, `.usage`, `.toolcalls`) are not relayed. Labels already
  travel as `session.labeled` events. The board loses the `.touched` freshness for a Run's session.

## Rejected

- **Symlinking or mounting the sink straight into the host's `state/sessions`.** A line's own
  `session` field would forge rows for any host session, and its `cwd` with them.
- **A bind mount per session log.** Subagent ids are unknown at `docker run`, and a bind source must
  already exist.
- **A per-session subdirectory the host reads.** Tenaza v0.5.2 reads `state/sessions` flat
  (`src/log.ts:217,239,302`), so it would need a Tenaza change.
- **A fresh sink per Sandbox.** A Continuation's line numbers would stop matching the host copy,
  and a live answer would never find its Inbox item.
