# Crisol glossary

Crisol is a macOS CLI that runs one Task in a container, unattended, and leaves exactly one named
branch in the host repo. Seeded from the spec's own Vocabulary (crisol-v1 spec, 2026-10-27).

**Run**:
One Task executed in a Sandbox, from launch to Run result, and again through each Continuation.
Identified by a run id.
_Avoid_: Job, execution, invocation

**Continuation**:
A Run taken up again after its Run result, on its own Clone and agent session, with a new request
as its input. It rewrites the Run result and never creates another branch.
_Avoid_: Resume (what an Adapter does between iterations), Retry, Rerun (those start from scratch)

**Task**:
The text a Run works on: a phrase, or the content of a `--file`, after any Template is applied.
Context is never part of it.
_Avoid_: Prompt, request (the prompt is what the agent receives: the Preamble, the Task and any
Context together)

**Context**:
A file given with `--context`, handed to the agent after the Task, in its own section marked as
reference material rather than work. UTF-8 text only.
_Avoid_: Attachment, input (Context informs the Task; it is not something to act on)

**Template**:
A Markdown file named by `--prompt` that wraps the Task, whose only variable is `{{task}}`. Found
in the repo's `.crisol/prompts/`, then `~/.crisol/prompts/`, then Crisol's built-in ones.
_Avoid_: Prompt (the flag is `--prompt`, but what it names is a Template, not the prompt itself)

**Sandbox**:
The container a Run executes in, on its own internal network.
_Avoid_: Container, VM (Sandbox is the domain term; "container" is the mechanism underneath it)

**Sandbox block**:
The `## Sandbox` section `crisol init` appends to a repo's agent instructions, declaring the two
entry points an agent that dispatches work calls: run one Task, and continue a Run by its branch.
_Avoid_: Manifest, config (it is prose an agent reads, not a file Crisol parses)

**Clone**:
The Run's own local git clone on the host, mounted into the Sandbox.
_Avoid_: Worktree, workspace, checkout (a worktree shares the host's `.git` and was rejected for
exactly that reason — see docs/adr)

**Fetch-back**:
The host-side step that brings the Run's branch from the Clone into the host repo: it fetches the
commits, then moves the branch only from where the round began. Never skipped.
_Avoid_: Sync, merge, pull (Fetch-back never merges a working tree — it only moves a ref)

**Gate**:
A command whose exit code decides whether the work is right (`bun test`).
_Avoid_: Check, test, CI step

**Run result**:
The stable JSON a Run returns; its Status is `verified`, `unverified`, `not-converged`, `parked` or
`checkpoint`, never anything else. The last two come only from a Stop line.
_Avoid_: Output, report, response

**Final message**:
The agent's last message in a Run, as its Adapter received it, kept verbatim in the Run result.
Crisol reads nothing in it but the Stop line.
_Avoid_: Report, summary (Run result already rules out "report"), Handoff (a caller's baton is a
section inside a Final message, not the message)

**Stop line**:
The marker line ending a Final message when the agent stopped on purpose, naming why. Crisol reads
it before running the Gates and, when present, never resumes the session.
_Avoid_: Exit code, signal, flag (it is text the agent writes, not a process mechanism)

**Adapter**:
The only code that knows a specific agent (v1: Claude Code). Named in the Run result; a
Continuation refuses a different one.
_Avoid_: Integration, driver, connector

**Slot**:
One of `max_parallel` OS file locks a Run must hold to execute.
_Avoid_: Worker, thread, lock (a Slot is what a Run holds, not the lock mechanism itself)

**Run lock**:
The OS file lock a live Run holds on its own dir (`runs/<id>/lock`) from reservation until its
Run result is written. A Run whose lock can be taken is dead unless its current Run result records
a completed Fetch-back, and `crisol recover` may bring back its branch. A Continuation re-takes the same lock for its round, and `crisol gc` takes it too,
from the moment it lists a Run as collectable until it is collected or the plan is declined, so
neither ever acts on the other's Clone.
_Avoid_: Slot (a Slot bounds how many Runs execute at once; a dead Run's Slot may already belong to
another Run), pid file

**Detached Run**:
A Run started with `crisol run --detach`: reserved in the foreground, then run to its Run result by
a background process of its own, which holds its Run lock. Still one process per Run; Crisol has no
daemon.
_Avoid_: Background job, daemon (no long-lived process serves several Runs)

**Fan-out**:
Several independent Runs from one `crisol run`, one per Task, all cut from the same base commit.
Never chained, never merged.
_Avoid_: Batch, matrix, parallel run (parallelism is what Slots bound, across every process; a
Fan-out is what one invocation asks for)

**Allowlist**:
The hostnames a Sandbox may reach, merged from three levels: built-in (shipped with Crisol), user
(`~/.crisol/network`) and repo (`.crisol/network`). Plain hostnames only — it never names a
port, a wildcard or an IP address.
_Avoid_: Whitelist, firewall rule

**Service**:
A container `.crisol/services.yml` declares, one instance per Run, reachable by its own name on
the Run's network, destroyed with it. The agent launches only once every Service's healthcheck
passes; one that never becomes healthy, or exits first, fails the Run before any iteration is
spent.
_Avoid_: Dependency, sidecar (a Service is scoped to one Run, like the Sandbox — never shared or
long-lived across Runs)

**Project layer / Agent layer**:
The two image layers: the project's toolchain, and the agent on top.
_Avoid_: Base image, Docker layer (those name the mechanism; Project layer / Agent layer name
what each one is FOR)

**Preamble**:
The text Crisol puts before every Task: the agent is in a sandbox, the Run's Gates by command,
commit and do not push, name a network block in the Final message rather than work around it, and
end with a Stop line when it stops on purpose. An Adapter may replace its wording, but it must still
name every Gate.
_Avoid_: System prompt, header (the Preamble travels with the Task, not as a system prompt)

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
