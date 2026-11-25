# `gc` ages a Run by a stored `finishedAt`, verifies its branch against the host live, and reads `--include-failed` as narrowly as the spec allows

Ticket 16 makes `crisol gc` the only way disk is ever freed. These are the choices the spec left
open, and what was verified live rather than assumed.

## Age comes from a new `finishedAt` field, never a dir's own birthtime

`runs/<id>/`'s birthtime is set when the Run is *reserved*, not when it finishes, and `listRuns`
already uses it for a different purpose ("oldest first"). Verified live: once a directory exists,
`utimes`/`touch` only ever move its `atime`/`mtime` — its birthtime cannot be back-dated, so no
test could simulate "7 days old" without actually waiting 7 days. `RunResult` gains
`finishedAt: number` (epoch ms), written alongside `fetchBack` in both places a Run result is
computed (`run()`'s own exit, and `endUnstartedRun`'s). A Run result written before this ticket
has no `finishedAt` at all; `planGc` treats that as unknown age, not "old enough" (`now - undefined`
is `NaN`, and `NaN < GC_MIN_AGE_MS` is `false`, which would otherwise let a pre-existing Run through
the one gate meant to keep it out) — skipped as `no-record`, left for a human to remove.

## "The recorded commit" is read live from the Clone, never persisted

The spec's `gc` deletes `repo/` only after verifying the branch is in the host "at the recorded
commit." Nothing new is stored for this: `repo/` is still on disk when `gc` runs, so its own branch
tip (`git rev-parse refs/heads/<branch>` inside the Clone) *is* the recorded commit — the same
comparison `crisol recover`'s `recoverDeadRun` already makes between a Clone and its host. A
mismatch, or the branch missing from either side, refuses the Run as `branch-moved`.

## `--include-failed` lifts only the status restriction

The spec ties the "older than 7 days" clause to `verified`/`unverified` Runs, then separately says
`not-converged` Clones "stay unless `--include-failed`." Read literally, it is ambiguous whether
`--include-failed` also waives the age and branch-verification checks for a `not-converged` Run.
This ticket reads it narrowly: age, Fetch-back completion and the branch-at-commit check apply to
every Run regardless of status; `--include-failed` only moves a `not-converged` Run from "kept" to
"eligible," identically to a `verified`/`unverified` one. The stricter reading matches the spec's
own framing ("disk is freed only on request… and only after I confirm") better than letting one flag
bypass every other safety check at once.

## The confirmation prompt is one comparison, not a parser

Reads one line of stdin; `y`/`yes` (case-insensitive) proceeds, anything else — including an
immediate EOF — declines. Verified live against `Bun.spawn`: with `stdin` unspecified it behaves
like `"ignore"` (EOF at once, `isTTY: undefined`), and with `stdin: "pipe"` left unwritten the child
hangs until the parent closes it — so a script that forgets to answer never silently deletes
anything, and a test supplies `"n\n"`/`"y\n"` over a real pipe rather than an injected test seam.
No `--yes` escape hatch exists yet: ticket 07's own ADR 0013 found a hand-rolled confirmation flow
(a y/N prompt plus a line editor) was the source of every real defect in that ticket, so this one
stays the minimum a terminal needs.

## Deletion scope is exactly `repo/` and the per-Run `network/` dir

Matches the spec's own checkboxes (`log` and `result.json` both "remain") plus ticket 06's carried
note ("gc must also delete the per-Run `network/` dir"). `lock`, `pid` and `prompt` are untouched
too — none of them were ever in scope.

## The size-warning threshold is a plain byte count, overridable in `~/.crisol/config`

20 GB by default — roughly five Runs at the spec's own high estimate (2-4 GB each). `gc_warn_bytes`
joins `max_iterations`/`timeout_minutes`/`max_parallel` as another `extractIntKey` in
`config.ts`, resolved the same way (`resolveGcWarnBytes`, beside `resolveMaxParallel` and
`resolveCapacityLimits` in `run.ts`'s sibling style, but living in `gc.ts` since the warning itself
does). It is read as raw bytes rather than GB so a test can set it to `1` and trip the warning
against a real, tiny fixture Run instead of writing gigabytes of throwaway data to disk.

## The size check is an incremental counter, never a walk of `runs/` (owner review, round 2)

The first cut computed the warning by recursively `readdirSync`/`lstatSync`-ing all of `~/.crisol/runs`
on every foreground `crisol run` — cheap when the suite's own fixtures are tiny, but since ticket
12 every Clone carries its own `node_modules`, and the walk's cost is the total FILE COUNT across
every Run ever made, not the one Run that just finished. Measured on a scratch tree built to the
same scale the review reported (210,665 files, 3.25 GB, via sparse files so creating it costs no
real disk): the walk took 642 ms in this environment (the review's own measurement, on a different
machine/filesystem, was 6029 ms) — and it only gets worse as Runs accumulate, since nothing before
this fix ever shrank that total except `gc` itself.

Fixed by tracking the total incrementally instead of ever re-deriving it: `~/.crisol/runs-size`
(sibling to `runs/`, so it is never mistaken for a run id) holds one decimal number. `run()` adds
to it once, right where it writes `result.json` (`runDirSizeBytes` — `repo/` plus `network/`, for
that ONE Run only); `collectRun` subtracts exactly what it just freed. The end-of-run check becomes
one small file read, `trackedRunsSizeBytes`, independent of how many Runs exist or how many files
their Clones hold — measured on the same scratch tree at 0.117 ms (the file is read in isolation;
the 210,665-file tree underneath it is never touched). A lost update under true concurrent
completions (two Runs finishing in the same instant) is accepted rather than guarded with a new
lock, since this is a nag, not a safety check. Runs made before this fix shipped never added
anything either — the counter starts at 0. See round 3 below for how drift of any kind — this one
included — gets corrected.

## `finishedAt`'s mtime fallback was rejected after a live probe (owner review, round 2)

Tempting fix for a legacy Run with no `finishedAt`: fall back to `result.json`'s own mtime, since
it is written exactly once, at completion. Probed live instead of assumed, with a real `crisol run`
against a scratch `CRISOL_HOME`: `crisol status` never touches `result.json` (mtime held across a
`status` call). `crisol recover` does — `markFetchedBack` only skips its write when `fetchBack` is
ALREADY `true`; a Run whose `result.json` says `fetchBack: false` (the normal state for any
pre-this-ticket Run that was ever interrupted) gets `result.json` fully rewritten the next time
`crisol recover` runs, even when the branch had already reached the host, which moves its mtime to
the recovery moment, confirmed by a real `stat` before and after (mtime changed, `fetchBack` flipped
false→true). `crisol detach`'s own code never writes to an already-finished Run's `result.json` at
all. Since something — `recover` — does rewrite it after the Run truly ended, the fallback was not
added: a legacy Run with no `finishedAt` keeps the `no-record` refusal, same as before this round.

## `crisol gc` reconciles the counter from a full walk, every time (owner review, round 3)

Round 2's "the next `gc` run corrects the drift" was false: `collectRun` only ever subtracted what
it itself just froze, never re-measured anything, so a Run dir removed by hand (`gc` itself says to
do exactly that for a `no-record` Run), a dead Run `crisol recover` brought back without ever adding
its size, or any Run from before the tracker existed, all left the counter permanently wrong with no
path back to true. Fixed by making `crisol gc` the reconciliation point: `measureRunsSizeBytes`
walks every Run dir under `runs/` (summing `runDirSizeBytes` per id — the same full walk ticket 16's
first cut used for the warning, now confined to this one explicit, rare command), and
`reconcileTrackedSize` overwrites `runs-size` with that measured truth. `crisol run`'s own
end-of-Run check is untouched — still the cheap counter read.

`runGcCommand` calls `reconcileTrackedSize` as the last thing it does on every path out — "nothing
to collect," the user declining, and after a confirmed collection alike — so `collectRun` no longer
needs to touch the counter itself at all (reverted to its original two-argument form). Reconciling
on a decline was a real choice, not a given: the alternative — skip it, since the user said no —
would leave a known-wrong counter wrong until the next `gc` someone actually confirms, which is
exactly the "nothing ever reconciles it" bug this round exists to close. Declining only means
nothing on disk changes; the counter is bookkeeping, not disk, so correcting it costs nothing and
owes the user nothing in exchange for a "no." The README names `crisol gc` as what resyncs the
total, so a warning that looks wrong has an answer.

## Ticket 35 amends this (2026-11-23): a branch merged and deleted is collected

"The branch missing from either side refuses the Run as `branch-moved`" kept every reviewed Run
forever: merging the branch and deleting it is how one normally ends, so its 2-4 GB `repo/` stayed
and `gc` printed a refusal for it on every call. The check exists so `gc` never destroys work that
exists nowhere else, and a Clone tip the host still reaches is not that work.

So a branch gone from the host is no longer refused by itself. The Clone's tip is still read through
`cloneBranchSha` (ADR 0029: host git reads a Clone only as a remote), and the host repo is asked
whether any `refs/heads/*` or `refs/tags/*` contains it (`git for-each-ref --contains`). If one does,
the Run is collected like any other. If none does, it stays refused as `branch-moved`, and the
reason says the work exists only in this Run's Clone; a squash merge leaves a Run that way, as does a
branch deleted without merging. A tip the host never received reads as reached by nothing, never as
an error.

A branch that still exists in the host at a different commit is refused exactly as before.
