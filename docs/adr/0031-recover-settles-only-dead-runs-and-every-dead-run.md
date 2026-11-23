# Recover settles only dead Runs, and every dead Run

Ticket 34: a review of the 0.1.0 deliverable found three ways `crisol recover` acted on the wrong
set of Runs. A first-round Run killed before writing `result.json` was fetched back but never
settled, so `status` showed it `dead` forever, `gc` never saw it and `--continue` could not find it.
A Continuation stopped while queued for a Slot left the Run lock newer than the previous round's
result, so `status` and `recover` read that real `verified` or `parked` result as stale, and recover
overwrote it with `not-converged`. And every finished Run with a free lock counted as dead, so after
the usual merge-and-delete recover re-created the deleted branch, and on a branch the user had
advanced it reported `FAILED` and exited 1 on every call.

## The lock record carries what a first round's result needs

`lockRun` now writes the round's `base` (`<ref>@<sha>`), `network` and, when the Adapter has a name,
`adapter` beside `host` and `branch`. A dead Run with no `result.json` is settled from that record:
`status: "not-converged"`, the same `interrupted` reason ADR 0025 uses, `iterations: 0`, empty
`gates`, `blocked` and `warnings`, `fetchBack: true`. Recover has no evidence of what the dead round
did before it died, so it claims none. With `base` and `adapter` recorded, `--continue` parses the
base and inherits the Adapter exactly as it does for a Run that finished on its own.

A lock written before these fields existed holds only `host` and `branch`. Recover still fetches
that Run's branch back but writes no result, since it has no base to give one.

## An unstarted Continuation puts the lock's mtime back

`resultIsStale` (ADR 0025) reads a lock newer than the result as a round that began and died.
`reserveContinuation` bumps that mtime before the Slot wait, so a Continuation ended before it held
a Slot looked exactly like one. `endUnstartedContinuation` now restores the mtime the lock had
before the reservation. The previous round's result stays current, and the ADR 0027 protection of
a `parked` or `checkpoint` result stays too.

A Continuation killed with `kill -9` while still queued never reaches `endUnstartedContinuation`, so
its lock keeps the new mtime, and recover settles the previous result as interrupted. Nothing on
disk tells that round apart from one that held a Slot and died before writing, so this stays as
ADR 0025 left it.

## A current result that records a Fetch-back is not dead

A free lock no longer means dead on its own. Recover skips a Run whose current (non-stale) result
has `fetchBack: true`: its branch reached the host, and from then on merging, deleting or advancing
it is the user's call. Such a Run prints nothing, so a home holding only finished Runs prints
`Nothing to recover.` A finished Run whose own Fetch-back failed still has `fetchBack: false`, and
recover still brings its branch back.

Amends ADR 0010 (a free Run lock proved death) and ADR 0025 (which settled only a stale result,
never a missing one).
