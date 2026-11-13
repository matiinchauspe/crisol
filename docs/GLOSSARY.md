# Crisol glossary

Crisol is a macOS CLI that runs one Task in a container, unattended, and leaves exactly one named
branch in the host repo. Seeded from the spec's own Vocabulary (crisol-v1 spec, 2026-10-27).

**Run**:
One Task executed in one Sandbox, from launch to Run result. Identified by a run id.
_Avoid_: Job, execution, invocation

**Task**:
The text a Run works on: a phrase or a ticket file, plus optional Context files.
_Avoid_: Prompt, request (the Preamble and the Adapter turn it into a prompt; the Task itself is
the human's own input, before that)

**Sandbox**:
The container a Run executes in, on its own internal network.
_Avoid_: Container, VM (Sandbox is the domain term; "container" is the mechanism underneath it)

**Clone**:
The Run's own local git clone on the host, mounted into the Sandbox.
_Avoid_: Worktree, workspace, checkout (a worktree shares the host's `.git` and was rejected for
exactly that reason — see docs/adr)

**Fetch-back**:
The host-side `git fetch` that brings the Run's branch from the Clone into the host repo. Never
skipped.
_Avoid_: Sync, merge, pull (Fetch-back never merges a working tree — it only moves a ref)

**Gate**:
A command whose exit code decides whether the work is right (`bun test`).
_Avoid_: Check, test, CI step

**Run result**:
The stable JSON a Run returns; its Status is `verified`, `unverified`, or `not-converged`, never
anything else.
_Avoid_: Output, report, response

**Adapter**:
The only code that knows a specific agent (v1: Claude Code).
_Avoid_: Integration, driver, connector

**Slot**:
One of `max_parallel` OS file locks a Run must hold to execute.
_Avoid_: Worker, thread, lock (a Slot is what a Run holds, not the lock mechanism itself)

**Run lock**:
The OS file lock a live Run holds on its own dir (`runs/<id>/lock`) from reservation until its
Run result is written. A Run whose lock can be taken is dead, and `crisol recover` may bring back
its branch.
_Avoid_: Slot (a Slot bounds how many Runs execute at once; a dead Run's Slot may already belong to
another Run), pid file

**Fan-out**:
Several independent Runs from one `crisol run`, one per Task, all cut from the same base commit.
Never chained, never merged.
_Avoid_: Batch, matrix, parallel run (parallelism is what Slots bound, across every process; a
Fan-out is what one invocation asks for)

**Allowlist**:
The domains a Sandbox may reach, in three levels.
_Avoid_: Whitelist, firewall rule

**Project layer / Agent layer**:
The two image layers: the project's toolchain, and the agent on top.
_Avoid_: Base image, Docker layer (those name the mechanism; Project layer / Agent layer name
what each one is FOR)

**Preamble**:
The fixed text Crisol prepends to every Task.
_Avoid_: System prompt, header (the Preamble is specific to the Task text, and the Adapter may
tune its wording — it is not a generic system prompt)

**Secret**:
An env var NAME an Adapter or a repo declares — never its value. Resolved to a value from
`SecretStore` (Adapter-declared) or the host's own environment (repo-declared) right before the
Sandbox starts; a missing one fails the Run before launch, naming it.
_Avoid_: Credential (too broad — git identity and the Claude token are both "credentials" but
only the token is a Secret by this definition), Token (one specific Secret, not every Secret)

**SecretStore**:
Crisol's own store for a Secret's value, outside any Run (v1: the macOS Keychain, behind one
Crisol-owned entry). `crisol auth` is its only writer; `run.ts` reads it for an Adapter-declared
Secret.
_Avoid_: Vault, keychain (lowercase "keychain" names the v1 mechanism; SecretStore is the
interface above it — see docs/adr/0007)
