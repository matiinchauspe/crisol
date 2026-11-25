# The ceiling is a timer, and the Sandbox's removal ends what it interrupts

Ticket 33: the 60-minute ceiling (ADR 0006) was a clock read only after a Gate failed, started only
after the first turn returned. A turn or a Gate that never returned — a hung `claude -p`, a
watch-mode test — never reached that read, and neither did a Run with no Gates, so such a Run held
its Slot and container forever and `--timeout` / `timeout_minutes` delivered nothing.

## The clock starts before the first turn and runs as a timer

`armWallClock` (`src/run.ts`) starts right before the first turn and rejects with `CeilingReached`
when `ceilingMs` runs out. `converge` races it, beside the interruption promise, so the Run moves on
at the deadline whatever is in flight: a turn, `reportCompletion`, a Gate. Checking the clock between
steps is not enough on its own, since a step that never returns gives the check no turn. The
iteration half of the ceiling stays where it was, after a red Gate.

The losing `converge` keeps running until its own await returns. After every await it checks the
interruption and the clock and throws, so it never resumes the agent nor writes `status`,
`gateResults` or `finalMessage` once the Run has moved on.

## Removing the Sandbox is what kills the exec

`docker exec` has no way to kill the process it started. Both checked live: a `sleep 3600` started
by `docker exec` is still running after a `kill -9` of its client, and a `docker exec` of
`sleep 3600` exits 137 within a second of `docker rm -f` on its container. So on
`CeilingReached` the Run tears the Sandbox down at once, before the commit scan, rather than at the
usual teardown point after it: an agent still running in a live container could commit past the
scan, and Fetch-back would bring that commit back unscanned. The usual teardown then skips the
Sandbox; Services and the Allowlist proxy come down as on every other exit.

## A timed-out Run resolves like any ceiling

It ends `not-converged` with `reason: "ceiling"`, the same value the iteration ceiling reports, and
resolves rather than rejects. `iterations` counts the turns that finished, so a first turn cut off
reports `0`, the same count a provider failure in `launch` reports (ADR 0017). `gates` holds the
last full round of Gates, if any finished; a round cut off records nothing.

Rejected:
- **A per-exec timeout passed into `Sandbox.exec`** — each exec would need the remaining budget
  threaded through the Adapter interface, and a timeout on the `docker exec` client still leaves
  the process running in the container.
- **A new `reason` value for the wall clock** — the Run result's `reason` is a public contract, and
  the spec names a single `ceiling` for both halves. The log tells them apart.
