# A Run is reserved before its Slot, and a detached Run inherits its Run lock

Ticket 05 adds `crisol run --detach`, `crisol status` and `crisol logs`. Crisol stays daemonless:
each Run is owned by its own process. Three choices were needed. One of them reverses part of ADR
0009 and narrows ADR 0010; the amendments appended to both record how.

## A Run is reserved before it waits for a Slot

ADR 0009 took the Slot before the Run reserved anything, so a queued Run had no run id and nothing
on disk. Ticket 05 needs both. `--detach` must print the run id at once, even when every Slot is
taken. `crisol status` must show a queued Run as queued, and it can only see Runs that are on disk.

So a Run now reserves its dir, its Run lock and the lock record right after pre-flight, and only
then waits for a Slot. Pre-flight still runs first, so a Run that would fail still fails at once
and leaves nothing. A foreground Run interrupted during pre-flight leaves nothing as well: it yields
once to let a signal caught during a synchronous spawn reach its handler (ADR 0010), then checks
for it before it reserves.

A Run that ends before it holds a Slot, by a signal or an error, keeps its run dir. It writes its log line
and a Run result (`not-converged`, `reason: "interrupted: <SIGNAL>"` or `error: …`,
`iterations: 0`, `fetchBack: false`) and only then lets go of its Run lock. It never made a Clone,
so it cut no branch and nothing is fetched back. The spec keeps `log` and `result.json` always and
makes `crisol gc` the only cleanup, and `--detach` may already have handed the id out. A first
version deleted the dir instead, honouring ADR 0009's "a queued Run leaves no trace". That made a
detached Run's id vanish from `status` and `logs` when it was stopped, so ADR 0009's promise is
dropped here. `crisol recover` passes over such a Run without naming it, since its Run result
already says how it ended.

A queued Run killed with SIGKILL writes no Run result. `status` shows it as `dead`, and `recover`
reports it as skipped because it has no Clone.

The only reserved dir Crisol still deletes is one whose id was never handed out: `--detach`
removes its reservation when it cannot start the background process.

## `status` reads state from what is on disk

`crisol status` reads each run dir:

- `result.json` exists: the Run finished, shown with its Status (and `reason`).
- otherwise the Run lock is held by the Run's own process: `running` once the Clone `repo/`
  exists, `queued` before that. The Clone is the first thing a Run makes after it takes a Slot, so
  no extra state file is needed.
- otherwise: `dead`. The Run died without writing its Run result. `crisol recover` brings back
  its branch if it has a Clone.

A Run writes its result before it lets go of its lock, so "no result" is final only once the
Run's own process is known to be gone. Status re-reads `result.json` at that point, whether it
learned it by taking the lock or by finding the owner gone. Otherwise a Run finishing between
status's two reads would show as `dead` once.

Status reads the lock record before it tries the lock, just like recover (ADR 0010). It skips a
dir that has no record yet. If it tried the lock of a Run still being reserved, it could take that
lock first and make the reservation fail.

`status` and `recover` probe a Run's lock read-only, without `O_CREAT`. A Run's own lock and the
Slots open with `"a"`, which creates the file. A probe that did the same, racing a dir being
removed, would bring back an empty `lock` with no record, which every later probe skips. A missing
lock file means the Run is gone, and the probe passes over it. Checked: a read-only fd takes and
respects the same `flock` as an append fd, and opening a missing file read-only creates nothing.

Each live Run also writes `runs/<id>/pid`, the pid of the process that owns it. `--detach` prints
it, and `status` shows it for `queued` and `running` Runs. That is how a detached Run is stopped.

A held Run lock does not prove that pid: it proves only that some process holds the lock.
`crisol recover` holds a dead Run's lock for its whole Fetch-back, and the OS may have given the
dead owner's pid to an unrelated process, which ADR 0010 named as the reason it rejected pid files.
So `status` trusts the pid only when `lsof -a -p <pid> -- <lock>` finds that process with the
Run's lock file open. When the pid file names a process that does not hold it, the owner is gone,
and the Run is `dead`, whoever holds its lock. A held lock with no pid file yet belongs to the
process that reserved the Run, between reserving it and handing it over; it shows without a pid.
If `lsof` cannot be run at all, the pid is left out rather than the Run called dead.
Checked: `lsof` exits 0 only for the pid that has the file open, 1 for another live pid, pid 1 or
a pid that does not exist, in about 50 ms.

## A detached Run inherits its Run lock as fd 3

`crisol run --detach` runs pre-flight and reserves the Run in the foreground process. That way a
bad base, name or Gate is still reported in the terminal, with nothing left behind. It then starts
the same command again as a background process, without `--detach`. The background process gets
the parent's Run lock fd as its fd 3, and its stdout and stderr are appended to the Run's `log`.
The parent keeps its copy until the background process has taken the Run over. That process arms
its signal handlers, takes the Run, and only then writes its pid file. The parent waits for that
pid, and only then closes its copy and prints the run id and pid. So a `kill` of that pid, however
soon it comes, ends the Run with a Run result. A first version returned as soon as the process was
spawned, so a `kill` that came before Bun had loaded Crisol left a `dead` Run with no result. If
the background process exits before taking over, the parent, still holding the Run, writes the Run
result itself (`error: …`) and reports it.

The background process takes the Run over before its own pre-flight, so a pre-flight that fails
there (Docker stopped, a `--name` branch created since) also ends with a Run result, not a `dead`
Run.

`flock` belongs to the open file description, not the process. The background process's fd 3 is
the same description, so the lock stays held from reservation to Run result and is never free in
between. If the lock were dropped and taken again, a `status` or `recover` in that gap could see
the Run as dead, or take the lock and make the background process fail. The background process
checks that fd 3 is the Run's lock file before using it. The run id and the pinned base reach it
in one environment variable, `CRISOL_DETACHED`.

The background process is spawned with `detached: true`, so it runs in its own session with no
controlling terminal. Closing the terminal or pressing Ctrl+C there never reaches it. To stop it,
`kill` the pid that `--detach` and `status` show. It then stops like any Run (ADR 0010).
`CRISOL_DETACHED` is deleted from its `process.env` once read, so a `crisol run` in a git hook
during Fetch-back never takes itself for this Run's process. Checked: that hides it from spawns
that pass `env: process.env` (every git call, and `docker run`/`exec`/`rm`). Spawns that pass no
`env` (`docker build`, `claude --version`) still get the environment from process start. Neither
runs Crisol.

Checked against the running system (Bun 1.4.3, macOS), not assumed:
- `Bun.spawn`'s `stdio` array passes a fourth entry to the child as fd 3, pointing at the same
  file.
- After the parent closes its fd and exits, another process still cannot take the lock. It frees
  only when the child exits.
- Processes the child starts with `Bun.spawn` or `Bun.spawnSync`, detached or not, do not get
  fd 3. So a `docker exec` that outlives a SIGKILLed Run cannot keep the Run lock held, the same
  guarantee ADR 0009 relies on for Slots.
- In a `bun build --compile` binary, `Bun.main` is under `/$bunfs/` and `process.execPath` is the
  binary itself. So the background process is started as `[execPath]` there, and as
  `[execPath, Bun.main]` when Crisol runs as a script. This was probed with a two-line compiled
  script, not with Crisol's own binary.

## Scope cut from the ticket

- `--detach` works with one Task only. With several Tasks it is refused, because each Run would
  need its own background process. A caller that wants several detached Runs runs one command per
  Task.
- `--detach` with `--json` is refused. A detached command prints only the run id. The Run result
  goes to `result.json`, and `crisol status` shows its Status.
- `--detach` returns after pre-flight, and pre-flight includes making sure the image exists. On a
  machine's first Run, that image build delays the return. Showing progress for the first build
  belongs to ticket 13.
- A detached Run's background process runs pre-flight again, after the parent's. It is not
  skipped, since secrets cannot be handed to it through the run dir.
