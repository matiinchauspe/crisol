# The prompt travels over stdin and is resolved once

Ticket 10 makes the Task text-only input (spec q9): a phrase or `--file`, an optional `--prompt`
Template, repeatable `--context`, and a Preamble before all of it. Review round 1 found two defects.
Each came from one design choice, so this ADR records the choices that replaced them.

## The Adapter receives one `prompt`, and the Claude Code Adapter sends it over stdin

`AdapterContext.task` is now `AdapterContext.prompt`. It holds the Preamble, then the Task in
`<task>` tags, then each Context file in its own `<reference file="…">` tags. The glossary keeps
"Task" for the user's own text, so a field holding all three could not keep that name.

The first build passed the prompt as an argument: `claude -p <prompt>`. Linux caps one argv
string at 128 KiB (`MAX_ARG_STRLEN`). Both reviewers reproduced a 200 KB `--context` failing with
`argument list too long`, and Crisol's own spec, README and ADRs together come to about 133 KB. A
NUL byte made `Bun.spawn` throw with the whole prompt in its message, and that message reached
`result.json` and stderr. Both failures happened after the Clone, the branch and the Sandbox
already existed.

So `Sandbox.exec(cmd, stdin?)` takes text to send over stdin (`docker exec -i`), and the Claude
Code Adapter runs `claude -p` with no prompt argument:

- **Launch**: the prompt goes over stdin.
- **Resume**: the feedback goes over stdin too, since it carries a Gate's whole output.

Checked against the cached agent image (`crisol-agent-claude-code:2.1.283`), with no token and
`--network none`:

- `claude -p` with empty stdin fails with "Input must be provided either through stdin or as a
  prompt argument when using --print".
- With text on stdin, or a 210 KB stdin, it gets past input handling and stops at `api_error`.

`instructions` still ride `--append-system-prompt` on argv. They come from the user's own
`~/.crisol/instructions.md` and are usually short.

## Input is read once, in the process the user launched

`src/task.ts` reads every user path: `--file`, each `--context` and the Template.

- **UTF-8 text only.** A NUL byte, invalid UTF-8 or an empty file is refused in pre-flight,
  naming the flag and never echoing the bytes.
- **The prompt is saved.** The full prompt is written to `runs/<id>/prompt` when the Run is
  reserved, so what the agent received is on record.
- **A detached Run never re-reads a path.** Its process reads `runs/<id>/prompt` instead,
  just as `base`/`baseSha` already ride the hand-off (ADR 0011). Before this, `--detach --file
  <(…)` failed with `EBADF` in the child, and deleting a temporary context file raced the child's
  pre-flight.

## Templates: repo, then user, then built-in

`--prompt <name>` resolves to `.crisol/prompts/<name>.md`, then `~/.crisol/prompts/<name>.md`, then
a built-in template (v1 ships `fix-bug`). A name starts with a letter or digit, followed by
letters, digits, `-` and `_`, so it cannot climb out of either folder. `{{task}}` is the only
variable:

- any other `{{…}}`, or none at all, fails before launch;
- `{{ task }}` is told to write `{{task}}`;
- the Task is substituted literally, so a `$&` typed in it stays as typed.

## An Adapter may reword the Preamble but must name every Gate

`Adapter.preamble?(gates)` replaces the default wording. Pre-flight fails if the returned text
does not contain every Gate command, because a Preamble that leaves a Gate out tells the agent
less than Crisol will check.

## Not addressed

- A `</task>` or `</reference>` inside the input closes its section early. Ruled theoretical.
- A detached Run re-resolves its Gates from the repo's `.crisol/config.toml`. If that file
  changes between detach and pre-flight, the Gates can drift from the ones the saved Preamble
  names.

## 2026-11-24 — a resumed session keeps the instructions it launched with

Review round 1 over 0.1.0 asked whether `instructions` reach a resumed turn, since only launch
passes `--append-system-prompt`. Checked live against Claude Code 2.1.331 on the host, the version
the Agent layer installs, in Crisol's argv shape (`--session-id` at launch, the message over stdin,
`--output-format json`):

- Launch appended a rule that names a marker only when the user says `ping`, so the marker never
  enters the reply. The launch reply did not name it.
- `claude -p --resume <id>` with `ping` and no `--append-system-prompt` replied with the marker.
- A fresh `claude -p` with `ping` and no appended rule did not.
- The session transcript holds the appended text, which is what `--resume` loads back.

So resume turns (`resumeWithFeedback`, `continueSession`) keep passing no instructions. A Run
resumes inside the Sandbox, where the transcript lives under the Adapter's `sessionStore`.
