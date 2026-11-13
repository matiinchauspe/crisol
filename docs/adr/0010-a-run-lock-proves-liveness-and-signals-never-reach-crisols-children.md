# A Run lock proves a Run alive, and a signal reaches Crisol, never its children

Ticket 04 makes Fetch-back run on every exit and adds `crisol recover` for the exit Crisol cannot
handle, SIGKILL. The spec says recover finds "Run dirs whose Slot lock is not held". ADR 0009 showed
that this cannot work: once a Run dies, a later Run may take the same Slot. These are the choices
made to close that gap and the signal gaps the ticket carried.

## Each Run holds its own lock, `~/.crisol/runs/<id>/lock`

The Run takes an exclusive `flock` on `runs/<id>/lock` right after `mkdir` reserves its dir. It
holds the lock until `result.json` is written, which happens after Fetch-back. The primitive is the
Slot's (`tryLockRun` in `slots.ts`, the only file that knows `flock`), so the OS drops the lock when
the process dies, SIGKILL included. `crisol recover` treats a Run whose lock it can take as dead,
and holds that lock while it works, so two recovers never race on one Run.

The lock file also holds `{host, branch}`. Recover needs both, and a dead Run never wrote
`result.json`. The record is written only after the lock is held, and recover skips a lock file
that has no record. Recover therefore never takes the lock of a Run that is still being reserved.
Run dirs made before this ticket have no record, so recover reports them as skipped. It does not
guess their branch from the log.

Checked against the running system, not assumed: writing and reading the lock file through other
file descriptors does not release a `flock` held on it. `flock` locks the open file description,
unlike an `fcntl` lock, which the process loses when it closes any fd on the file.

Rejected:
- **The Slot lock.** A later Run can hold the same Slot (ADR 0009).
- **A pid file.** The OS reuses pids, and a pid file says nothing once its process is gone. The
  OS releases a lock on its own.

## SIGINT, SIGTERM and SIGHUP stop a Run the same way, from the moment it is reserved

The handlers are armed right after reservation. Ticket 01 armed them only once the Sandbox was up,
which left the Clone, the branch cut and `docker run` uncovered. The Clone and the branch are made
even when a signal has already landed, so an interrupted Run still leaves its branch in the host,
at the base if nothing ran. The interrupt is checked before the Sandbox starts and raced against
the Adapter afterwards. Teardown removes the Sandbox through its handle. If that fails, or the
handle never came back (an interrupted `docker run`), teardown removes it by its
`crisol.run=<id>` label. A container that survives both is named in `warnings` and on stderr. A
later signal is logged and otherwise ignored, because Crisol never abandons a teardown half way.

SIGHUP (closing the terminal) is handled rather than left to `crisol recover`: recover would bring
the branch back, but only teardown removes the container.

A signal that lands while the CLI's own handler holds it, as the Run leaves the Slot queue, still
counts: the CLI aborts with the signal's name, and the Run treats an already-aborted signal as one
it received.

## Crisol's git and docker children run in their own session

A terminal sends Ctrl+C and hang-up to its whole foreground process group. Ticket 01's children
shared that group, so a Ctrl+C killed `git fetch` mid-Fetch-back and `docker rm -f` mid-teardown.
Every git call and every `docker run`, `exec` and `rm` is now spawned with Bun's `detached: true`,
which calls `setsid()`. Only Crisol receives the signal, and its handlers decide what to stop.
`docker build` is the exception: it runs before the Run reserves anything, where a Ctrl+C should
kill it at once.

Checked against the running system with real signals, not `process.emit`:
- `bun run src/cli.ts` runs in the process it was started as, so the test's pid is Crisol's.
- A `detached` `Bun.spawnSync` child gets its own process group, and a group SIGINT does not
  reach it. A non-detached child dies with `signalCode: "SIGINT"`.
- A signal that lands during a synchronous spawn reaches its JS handler only after the event loop
  turns. The Run therefore yields (`setImmediate`) after the Clone and after Fetch-back, so a
  signal in either is acted on and logged before the handlers are removed.

A detached child also outlives a SIGKILLed Crisol. In particular, the `docker exec` that drives
the agent keeps running inside a container nobody owns. Recover removes a dead Run's Sandbox
before it reads the Clone, so the branch it brings back is the Clone's final commit.

A `git fetch` killed by a signal anyway is retried, up to three attempts. It was stopped, not
refused, and fetching again is safe.

## `result.json` is written on every exit and records `fetchBack`

`result.json` used to be written only when a Run converged. Now it is written on every exit that
reaches Fetch-back, before the Run lock frees, and carries `fetchBack: true | false`. An
interrupted or failed Run is `not-converged`, with `reason` set to `interrupted: <SIGNAL>` or
`error: <message>`. The spec's Status set stays at three values. Recover sets `fetchBack` to `true`
once it has brought the branch back.

The CLI still reports such a Run as an error: exit 1, with the message on stderr. With `--json` it
prints no Run result for these exits. That was left alone here, and a `--json` caller reads
`result.json` for them.

## Recover covers every Run dir, each against its own host repo

Run dirs from every repo share `~/.crisol/runs/`. Recover walks them all, and Fetch-back goes to
the host named in each Run's lock record, not to the repo recover was started in. Fetch-back only
fast-forwards. A host branch that has moved past the Clone is reported as failed and never
overwritten, and recover never deletes a branch.
