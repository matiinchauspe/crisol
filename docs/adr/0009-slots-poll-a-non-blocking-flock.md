# Slots poll a non-blocking `flock`, taken before the Run reserves anything

Ticket 03 implements the spec's Slots (q12, q18): `~/.crisol/slots/<n>.lock`, an exclusive `flock`
through `bun:ffi` on libc, behind `SlotLock` in `src/slots.ts`. The spec fixed the primitive; four
choices it left open are recorded here.

## The wait polls `LOCK_EX | LOCK_NB` instead of blocking in `flock`

A blocking `flock(fd, LOCK_EX)` called through FFI stalls the JS thread until the lock frees. A
fan-out runs its Runs on that one thread, and so do the SIGINT/SIGTERM handlers that tear a
Sandbox down and still Fetch-back — a blocked thread would freeze every other Run and swallow
Ctrl+C. `acquireSlot` therefore tries every Slot with `LOCK_NB`, sleeps 250 ms, and tries again.
No ordering is promised between waiters; the spec asks only that a Run waits and never fails.

Checked against the macOS SDK headers and the running system rather than assumed:
`flock(int, int)` is exported by `/usr/lib/libSystem.B.dylib` (loaded from the dyld shared cache —
the file is not on disk); `LOCK_EX = 0x02`, `LOCK_NB = 0x04`, `EWOULDBLOCK = EAGAIN = 35`, and
errno is read through `__error()`. `flock` locks the open file description, so two `open`s in one
process exclude each other (a fan-out needs that), and Bun's `openSync` sets `FD_CLOEXEC`, so a
`docker exec` child that outlives a SIGKILLed Crisol does not keep the Slot held.
`test/slots.test.ts` proves the last two against a real SIGKILL with a surviving child.

The `dlopen` happens on first use, never at import, so on another OS the platform message still
wins.

## A Slot is taken after every pre-flight check and before `reserveRun`

A queued Run has validated its base, branch name, Gates, secrets, Docker and image, but has no run
id, no run dir, no Clone and no branch. Ctrl+C while waiting leaves nothing on disk, and a Run that
would fail pre-flight fails at once instead of after a long wait. The Slot is released after
Fetch-back, so a Slot covers every side effect a Run makes.

Consequence for ticket 04: a run dir does not record a lock of its own, so `crisol recover`
cannot yet tell a live Run from a dead one by lock alone (the log records `slot=<n>/<max>`, but
a later Run may hold that Slot). Recover will need its own liveness signal, or a per-Run lock.

## A fan-out prints one Run result per line

The spec's `--json` promise is "one Run result on stdout". With several Tasks, each Run result is
printed as one JSON line, in Task order — each line is exactly the single-Run contract, so a caller
that reads one Run reads every line the same way. Rejected: a JSON array, which would give a
fan-out a second output shape that no single-Run caller can parse.

## `--name` is refused with more than one Task

A name addresses one branch; three Runs cannot share it, and deriving `<name>-1`, `<name>-2` would
invent names nobody asked for. A caller that needs to address each branch (a `yun-build-plan`
walk) runs one Task per invocation with its own `--name`.

## Amendment 2026-11-13: a Run is reserved before its Slot

ADR 0011 reverses "a Slot is taken after every pre-flight check and before `reserveRun`". A Run now
reserves its dir, Run lock and record after pre-flight and before the Slot wait, so `--detach` can
print its id and `crisol status` can show it queued. A queued Run therefore has a run dir.
Ctrl+C while it waits ends it with a Run result (`interrupted: <SIGNAL>`), and the dir is kept
instead of leaving nothing on disk. A Ctrl+C during pre-flight still leaves nothing. The rest of
this ADR stands.
