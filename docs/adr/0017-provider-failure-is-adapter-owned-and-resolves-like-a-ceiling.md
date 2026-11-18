# A provider failure is Adapter-owned and resolves like a ceiling; `--json` now prints every computed Run result

Ticket 13 makes Crisol degrade plainly on a provider failure and a capacity limit. These are the
choices made, and what was verified live rather than assumed.

## A provider failure is a new `Adapter` error, not a string match on CLI output

`ProviderFailureError` (`src/adapter.ts`) carries a `category` ("rate limit", "quota", "auth", …).
Only the Adapter can tell a provider failure from any other agent-CLI exit, so classifying one is
the Adapter's job, the same way `declarePreStart` is. The Fake Adapter's `launch` can be told to
throw it immediately (`simulateProviderFailure`), before any script runs in the Sandbox — this is
also why `iterations` stays `0`.

The real Claude Code Adapter does **not** throw it yet. How `claude -p --output-format json`
actually reports a rate limit, an exhausted quota or a failed authentication is unverified: no
captured output exists in this repo, and the standing instruction for this ticket is to never call
the real `claude` to produce one. `ClaudeCodeAdapter.launch`/`resumeWithFeedback` still report every
non-zero exit generically as `error: <message>`. Classifying its real failures is left to a Run by
hand, the way ticket 14 (ADR 0008) caught the root-as-root and the attribution-boolean problems —
guessing a wire format here would be worse than leaving the gap open and named.

**Amendment 2026-11-18 (ticket 19):** the real Adapter now classifies a failed authentication. The
owner captured `claude` 2.1.283's output for an invalid API key, committed verbatim under
`test/fixtures/claude-auth-failure/` with the command that produced it. It exits 1 with
`"is_error": true`, `"terminal_reason": "api_error"` and `"api_error_status": 401` — and also
`"subtype": "success"`, so `subtype` is no signal, and the `result` text is prose. Any turn whose
output carries those three fields throws `ProviderFailureError` with category `auth`, its message
the `result` text. Everything else, another API error status included, still surfaces as
`error: <message>`. A rate limit and an exhausted quota stay open: they are classified only once
their own real captures exist, never inferred from this one.

## A provider failure resolves `run()`, like the ceiling — it is never thrown

The spec's own wording ("returns `not-converged` with `reason: provider: …`") matches how the
ceiling already behaves, not how every other `primaryError` behaves (those still reject — see
below). `run()` now special-cases `primaryError instanceof ProviderFailureError`: when Fetch-back
and the result write both still succeeded, it returns the computed `RunResult` instead of throwing.
Every other failure path (an unexpected Adapter exception, an interruption, Fetch-back also
failing) is untouched, so every existing rejection-based test keeps its exact expectation.

## `--json` now prints the Run result on every exit that computed one

Tickets 04 and 14 both carried the same gap into this one: a Run that writes `result.json` but
ends by throwing (an interrupted Run, an Adapter exception, Fetch-back also failing) printed
nothing on stdout with `--json` — ADR 0010 named this explicitly ("With `--json` it prints no Run
result for these exits. That was left alone here."). Rather than changing which exits reject (and
risk the exit-code and stderr-wording tests built on that), the already-computed `RunResult` is
attached to the thrown error (`attachResult`, an exported `RunFailure` shape) wherever one exists —
including a Run that never held a Slot (`endUnstartedRun`, now returning the result it wrote).
`cli.ts` reads it off a rejected outcome and prints it under `--json` exactly as it already prints
a fulfilled one. Exit codes, stderr text and every `instanceof`/`.toThrow(...)` assertion are
unchanged; only an additional `console.log` appears before existing tests ever look.

## A provider failure aborts a sibling Run still waiting for its Slot

"With a queued Run waiting, a provider failure keeps the queued Run from starting" needs one Run's
failure to reach another, live, Run in the same `crisol run "a" "b" "c"` invocation. `RunOptions`
gains `onProviderFailure?: (reason) => void`, called the moment a `ProviderFailureError` is caught —
before teardown, to give a polling sibling the earliest chance to see it. `cli.ts` wires it to
`interrupt.abort(reason)`, the SAME `AbortController` a fan-out's Runs already share for OS
signals; a Run still in `acquireSlot`'s poll loop sees `signal.aborted` and ends through
`endUnstartedRun`, exactly as a Ctrl+C-while-queued Run already does. Its `reason` reads
`interrupted: provider: <category>` — the existing `interrupted: <cause>` vocabulary, naming what
it was interrupted by, rather than inventing a third reason family.

## Capacity limits are the Sandbox's alone, verified live against OrbStack

`--cpus`/`--memory` are added to `docker run` for the Sandbox container only (`docker.ts`) — never
the Allowlist proxy or a Service container, matching the ticket's own acceptance criterion ("The
Sandbox runs with…"). Default 2 CPUs / 4 GB (`DEFAULT_SANDBOX_CPUS`/`DEFAULT_SANDBOX_MEMORY`),
overridable per-Crisol in `~/.crisol/config`'s `cpus` (a decimal, unlike every other integer knob)
and `memory` (Docker's own `<n>[bkmg]` syntax) keys, resolved the same way `max_parallel` already
is (`resolveCapacityLimits`).

Checked against the running system (OrbStack, docker 29.8.2), not assumed: `docker run --cpus 2
--memory 4g` is reflected in `docker inspect`'s `HostConfig.NanoCpus` (`2000000000`) and
`HostConfig.Memory` (`4294967296`), and enforced down to the container's own
`/sys/fs/cgroup/cpu.max` (`200000 100000`) and `/sys/fs/cgroup/memory.max` (`4294967296`) — `nproc`
inside the container still reports the host's full core count, a known Linux limitation of `nproc`
against cgroup `cpu.max`, not a Docker or Crisol defect.

## The "engine stopped" message needed no change

`assertDockerReachable` (ticket 02) already replaces any docker-engine connection failure with
Crisol's own plain message naming `orb start`, and `test/failure-paths.test.ts`'s "Docker engine
unreachable" test already pins it by pointing `DOCKER_HOST` at a socket path that does not exist.
Checked live rather than assumed: pointing `DOCKER_HOST` at a regular (non-socket) file and at a
real UNIX socket that is bound but has nothing accepting on it (a closer simulation of "the engine
was stopped") both produce the identical `docker info` exit code and "Cannot connect to the Docker
daemon" message, which `assertDockerReachable`'s generic non-zero-exit check already catches. No
new engine-unreachable code or test was needed.

## Deferred: the first image build shows no progress

Ticket 14's log also carried forward that the first `docker build -q` (now ~400 MB since ticket 12)
prints nothing until it finishes, so the CLI can look hung. This is not a failure or a degraded
path — the build is working, just slow — so it sits outside "Crisol degrades plainly" as this
ticket frames it, and fixing it well (streaming `docker build`'s own progress, deciding how that
interacts with `--json` and a detached Run's log) is a design question of its own, not a one-line
fix bundled into this ticket. Left open, named here rather than silently dropped.
