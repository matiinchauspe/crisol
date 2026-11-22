# Status and recover tell a stale result from the current round

Ticket 26: the first of ADR 0020's "Known limits" — `crisol status` showing a Continuation's
previous round while it runs, because `readEntry` read `result.json` before it ever looked at the
lock. `crisol recover` had the matching gap on the other side of a kill: finding a dead
Continuation, it flipped `fetchBack` on whatever `result.json` already held, leaving that round's
`status` and `finalMessage` to read as the dead round's own outcome.

## A lock newer than the result it names proves a later round

A Run's lock file is rewritten — same content, a new mtime — every time a round reserves it, fresh
or Continuation alike (`lockRun`). A `result.json` carries `finishedAt`, the moment the round that
wrote it finished. `resultIsStale` compares the two: a lock mtime after a result's `finishedAt`
proves a round started after that result was written and, since something is reading it as dead or
free right now, never wrote its own. `readEntry` already probed the lock before trusting the
no-result case; it now runs the same probe before trusting ANY result, and a stale one reads as
`"dead"` rather than `"finished"` — the same move ADR 0022 already made for `gc`, applied here to
`status`.

## Recover settles a stale result, not only its `fetchBack` flag

The old `markFetchedBack` only ever flipped one field. Renamed `settleResult`, it checks the same
staleness: a fresh result still only needs `fetchBack` set, but a stale one is rewritten whole —
`status: "not-converged"`, a `reason` naming the round interrupted, a fresh `finishedAt`, and no
`finalMessage`, which belonged to the round that never got to leave its own. `iterations`, `gates`,
`network`, `blocked` and `warnings` stay what the last completed round left, since recover has no
better evidence for what, if anything, the dead round did before it died.

## What stays unowned

No delivered-signal information survives a process's own death the way `run()`'s live interruption
handler captures one, so the `reason` recover writes names only that the round ended before
writing a result, never a cause the code never observed.

## Ticket 30 amends this: `adapter` is also carried over

The field list above left `adapter` out — an oversight, not a decision: the settled result should
carry it exactly as it carries `reached`, so a Continuation recovering from a crash still inherits
the right Adapter instead of being refused as if none had ever been recorded. Fixed in
`settleResult`; everything else above is unchanged.
