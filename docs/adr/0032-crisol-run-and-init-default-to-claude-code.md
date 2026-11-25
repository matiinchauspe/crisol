# `crisol run` and `crisol init` default to Claude Code

Ticket 36: a review of the 0.1.0 deliverable found that a user who installs it and follows the
README never reaches an agent. `crisol run` and `crisol init` built the scripted stand-in when no
`--adapter` was given, and the README's first example passed none. That Run committed a placeholder
file on a real `crisol/<id>` branch, and with green Gates it came back `verified` for a Task no agent
touched. The spec has v1 implement exactly one Adapter, Claude Code, so the stand-in was never meant
to be what a user gets.

## The default is `claude-code`

With no `--adapter`, both commands now build the Claude Code Adapter. The stand-in stays reachable
as `--adapter fake`, and only that way. It remains in the usage line, because the suite drives the
CLI with it and it is the only way to try Crisol without a token. A `--continue` with no
`--adapter` still inherits the Run's recorded Adapter (ADR 0026), so a Run made with `fake` keeps
continuing with `fake`.

The default moves only in the CLI. `run()` itself still falls back to a `FakeAdapter` when its
caller passes none: its callers are the CLI, which now always passes one for a fresh Run, and the
suite, which builds its own Adapters.

## The suite names the stand-in

Every test that starts a Run through the CLI on the default now passes `--adapter fake`, so no test
calls a model or builds the real Agent layer image, and none depends on what the default is. A test
that only checks argument parsing never builds an Adapter and is unchanged.

## What this amends

ADR 0021's Sandbox block declares `--adapter claude-code` because the default was still the
stand-in. The block keeps the flag: it is now redundant but still correct, and a dispatcher reading
it sees which Adapter it gets. ADR 0021's learn Run, which runs through `init`'s own `--adapter`,
now uses Claude Code by default, so accepting the offer needs `crisol auth` first.
