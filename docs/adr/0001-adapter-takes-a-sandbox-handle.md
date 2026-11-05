> **Partially superseded 2026-10-29 by
> [docs/adr/0005-pre-start-declaration-replaces-post-start-wiring.md](./0005-pre-start-declaration-replaces-post-start-wiring.md).**
> This ADR's own decision (the Adapter receives a `Sandbox` handle, not a raw container id) still
> stands. What no longer holds is the claim below that ALL FIVE points — including `authenticate`
> and `wireHooks` — receive an `AdapterContext` carrying a live `Sandbox`: those two now run
> BEFORE the Sandbox exists, contributing to a pre-start declaration instead. See ADR 0005 for why
> and for the corrected shape.

# The Adapter interface takes a Sandbox handle, not a raw container id

Each of the five points (`launch`, `authenticate`, `wireHooks`, `reportCompletion`,
`resumeWithFeedback` — spec q4/q7) receives an `AdapterContext` carrying a `Sandbox` (`exec` +
`stop`) and the Clone's absolute `repoPath`, never a bare Docker container id or `docker`'s own
argv shape. Chosen so the real Claude Code Adapter (a later ticket) composes against the exact
seam the fake Adapter already proves end to end in this ticket, and so `run.ts` never special-cases
which Adapter it is driving — only `docker.ts` knows Docker exists at all. Rejected: handing the
Adapter the container id directly, which would leak Docker's own CLI shape into every future
Adapter and make `wireHooks`'s Tenaza integration (a later ticket) reach past this boundary to
shell out to `docker exec` itself.
