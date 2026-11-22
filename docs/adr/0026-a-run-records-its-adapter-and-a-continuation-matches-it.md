# A Run records its Adapter, and a Continuation matches it

Ticket 28: nothing recorded which Adapter made a Run, so `--continue` without `--adapter`
defaulted to the fake Adapter and ran it over a real agent's branch — ADR 0020's rewritten
`result.json` fields never included one, and the README's Continuation example omitted the flag
too. Matías settled the open question before dispatch: no `--adapter` inherits the Run's own
recorded one rather than defaulting to the fake one, and an explicit `--adapter` that disagrees
with it is refused.

## `Adapter.name` is the identity the Run result keeps

Every real Adapter now carries a `name` (`FakeAdapter`: `"fake"`, `ClaudeCodeAdapter`:
`"claude-code"`), and `result.json` keeps it as `adapter`. A one-off test double with no
`continueSession` has no need of one — the field is optional on both the interface and the Run
result, so it never forces every existing test stand-in to invent an identity it does nothing with.

## `resolveAdapter` decides before any Sandbox starts

`findContinuedRun` now also reads the owning Run's recorded `adapter`. Right where `prepareRun`
used to default a missing Adapter straight to `new FakeAdapter()`, it instead:

- No Adapter requested, a recorded one exists → builds it by name and reports the inheritance
  (`onAdapterInherited`, which the CLI prints as `Continuing Run <id> with Adapter <name>
  (recorded by the Run).`).
- No Adapter requested, none recorded (a Run from before this ticket) → refused, asking for
  `--adapter` rather than assuming the fake one.
- An Adapter requested whose name differs from the recorded one → refused, naming both.
- An Adapter requested that matches, or no recorded name to disagree with → proceeds as given.

Building an Adapter by its recorded name is the CLI's own table (`createAdapter` in `src/cli.ts`,
today: `fake`, `claude-code`), passed into `run()` as `RunOptions.adapterByName` — `prepareRun`
keeps no mapping of its own, and no longer imports `ClaudeCodeAdapter` either, so core `run()`
never assumes which concrete Adapters exist. A test overriding `adapterByName` still lets
inheriting a non-fake identity skip the real Adapter's own CLI on `PATH`; with none supplied at
all, inheriting refuses before any Sandbox starts rather than guessing. All of this runs inside
`prepareRun`, before a Slot or a Clone, so a refusal here leaves the Run, its Clone and the host
branch exactly as ADR 0023's checks already do.

## What this leaves unowned

An Adapter's identity is a bare string Crisol never validates beyond equality — a renamed Adapter,
or an on-disk result hand-edited to a wrong name, is indistinguishable from a real mismatch. That
cost was already accepted implicitly for `gates.json`, `session-id` and every other kept-by-the-Run
file `findContinuedRun` trusts verbatim. Amends ADR 0020, whose rewritten `result.json` fields never
named an Adapter.

## Ticket 30 amends this: a crash is not the same as no record

`settleResult` (ADR 0025) rebuilt a stale result without reading `adapter` from it, so a Run that
crashed mid-round and was then recovered read exactly like one that predates this ADR — refused as
if it kept no record, naming an age it could not know. Fixed to carry `adapter` through that
rebuild too; the refusal above now says only that no Adapter was recorded, never that the Run
predates this Crisol version.

## Ticket 31 amends this (2026-11-21): `name` is required where `continueSession` is

Optional `name` let an Adapter that implements `continueSession` record no `adapter`, so its Runs
later fell into the "kept no record" refusal although that Adapter made them; continuing a named
Run with it read `not "undefined"`. A Run now refuses, before any Sandbox starts, an Adapter that
implements `continueSession` with no `name`; one without `continueSession` still needs none. On a
Continuation an explicit Adapter is checked for `continueSession` and a `name` before it is matched
against the recorded one, so a nameless one is refused for what it lacks, never by an `"undefined"`
name. `onAdapterInherited` — the CLI's `Continuing Run <id> with Adapter <name> (recorded by the
Run).` — now fires only once `adapterByName` has built the inherited Adapter, so an unknown recorded
name prints its refusal alone.
