# `gc` probes and holds the Run lock before collecting

Ticket 23: `crisol gc` decided a Run was finished from `result.json` alone. ADR 0020 gave a
Continuation its Run's own lock back, re-taken for the length of its round, but `gc` never checked
for it — an aged, verified Run past its 7-day mark looked exactly as collectable whether its lock
was free or a Continuation currently held it. `gc` could `rmSync` a Clone a Continuation was still
committing to.

## Probed the way `recover` already does

`recover` already tells a live Run from a dead one by trying to take its lock
(`probeRunLock`) rather than trusting any state on disk. `planGc` does the same, once it has a
Run's lock record: a lock still held means a Continuation is queued or running, and the Run is
skipped, reported `in-use` — a new `GcSkipKind` beside `branch-moved` and `host-missing`, surfaced
by `runGcCommand` the same way those two are. A lock `planGc` CAN take proves the Run genuinely
finished, the same proof `recover` relies on to call a Run dead.

## The lock stays held past planning, not just past the probe

Probing and releasing at once would only close the gap at the instant of the check — the real
race is the time between `gc` deciding a Run is safe and a human answering its confirmation
prompt, which can be arbitrary. So `GcCandidate` gains a `release()` closing over the `HeldLock`
`planGc` took; it is never released inside `planGc` itself. `runGcCommand` now holds every
candidate's lock from the moment it is printed as "ready to collect" until the Run is either
collected (`release()` called right after `collectRun`, in a `finally` so a failed delete still
frees it) or the whole plan is declined (every candidate released before returning). While a lock
is held this way, `reserveContinuation`'s own `lockRun` throws "already held by another process" —
no new refusal path was needed on the Continuation side; `gc` taking the same lock a Continuation
would have taken is what makes the existing one fire.

## What stays unowned

A `host-missing`/`branch-moved` candidate rejected AFTER the lock probe succeeds (the branch moved
while `gc` already held the lock) must still release it before skipping — `planGc` does, right
where it pushes to `skipped`. A lock that goes missing between `readRunLockRecord` and the probe
(`probeRunLock` returning `"gone"`) is treated the way `recover` treats it: silently skipped, on
the assumption that whatever cleared the file already resolved the Run.
