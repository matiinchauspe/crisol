# `gc` never ages out a parked or checkpoint Run

Ticket 29: `planGc` treated every status alike once Fetch-back had completed and 7 days had
passed — a `parked` or `checkpoint` Run, whose whole point is the agent session waiting for a
Continuation, got collected exactly like a `verified` one once it crossed the same age line.
Flagged by a review round over 16..19 (round 1): `src/gc.ts:145` protected only `not-converged`,
never the two statuses a Continuation actually needs the Clone and session for.

## A new `GcSkipKind`, checked ahead of age

`planGc` now checks `result.status === "parked" || result.status === "checkpoint"` right after
the `not-converged` check and before the `finishedAt`/age checks, so no amount of waiting ever
lets one through — unlike `too-young`, which clears itself in time. Skipped as
`awaits-continuation`, a new `GcSkipKind` beside `not-converged`. `--include-failed` does not
touch it: lifting the failed-Run restriction was never meant to also waive a Run a human might
still continue.

## Reported by name, not folded into the silent kinds

`reportRefusal`'s existing allowlist (`branch-moved`, `host-missing`, `in-use`) reports on
purpose for a Run whose state a caller might act on, and stays silent for
`too-young`/`not-converged`/`no-record`, which would otherwise print on every call for every Run
still waiting its turn. `awaits-continuation` joins the reported set: unlike `too-young`, a
parked or checkpoint Run never ages into being collectable, so staying silent about it would make
`crisol gc` look like it freed everything it could while one Run never will be, until someone
removes it on purpose.

## Removal stays manual

The ticket itself names "an explicit flag or run id" as what a deliberate removal could look
like — it does not rule either out. No `--run <id>` escape hatch was added here only because none
of the three acceptance criteria asks for one; this ticket's job was stopping the age sweep from
doing it silently, not building the deliberate path. The README names today's path directly, in
the garbage-collection section: removing the Run's dir by hand under `~/.crisol/runs/<id>` — the
same path a `no-record` Run was already told to take (ADR 0018). A later ticket is free to add a
flag.
