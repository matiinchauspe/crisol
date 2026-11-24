# The ceiling and a signal reach every step before the first turn

Amends ADR 0030. Only `converge` raced the interruption and the wall clock, and the clock started
right before the first turn. The steps before it were plain awaits: starting the Services, the
health wait, the dependency install. A Ctrl+C there was logged and nothing else happened until the
step returned, and a step that never returned held the Slot with no clock running. A hung
`npm ci` held it forever; a Service stuck at `starting` held it for the health wait's 10-minute
backstop. The only way out was `kill -9` and then `crisol recover`.

## The clock starts once the Run holds its Slot

`armWallClock` now runs right after the interruption is armed, before the Clone is made. The same
budget covers the Clone, the wall, the Services and their health wait, the Sandbox, the
dependency install and every turn. The install gets no limit of its own:

- One budget is one knob. `--timeout` and `timeout_minutes` already say how long a Run may hold a
  Slot. A second limit would need its own default, flag and config key, and the Run could still
  outlive what its owner set.
- A limit of its own would also leave the health wait and the Service start unbounded. One clock
  started early covers all of them.

The cost is that setup now spends the budget too. The default is 60 minutes and a normal setup
takes seconds to a few minutes, so the agent loses little of it. A ceiling reached before the
first turn ends the Run like any other ceiling: `not-converged`, `reason: "ceiling"`,
`iterations: 0`, and it resolves rather than rejects.

## How each step is stopped

- **The dependency install** races the interruption and the clock, as a turn does. The `docker exec`
  that runs it cannot be killed from the host (ADR 0030), so the teardown's removal of the Sandbox is
  what ends it.
- **The health wait** checks the interruption and the clock on every poll, every 500 ms. A
  stopped Run leaves the loop at once, so no background polling keeps the process alive after
  teardown. Teardown then removes the Services.
- **Starting the Services** checks between containers. A `docker run` that has already started is
  allowed to finish. ADR 0010 detaches it from Crisol's process group for the same reason: a
  `docker run` cut off mid-create can leave behind a container that nobody removes. On a stop,
  `startServices` removes what it already started. The wall and the Sandbox's own `docker run` are
  treated the same way and are checked right after they return.

A log line, `installing dependencies with <manager>`, now marks the start of the install. Before,
only its end was logged, so a hung install looked the same as one that never began.

Rejected:
- **A per-install timeout of its own** — see above: a second knob that still leaves the health wait
  unbounded.
- **Killing the `docker run` client of a Service or the Sandbox mid-create** — it trades a slow
  stop for a leaked container, the trade ADR 0010's detached children were made to avoid.
