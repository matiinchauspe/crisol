# Ticket 02's `.crisol/config.toml` parser and ceiling override are placeholders

Two parts of ticket 02's own scope stop short of the spec's full shape, the same way ticket 01's
`SKELETON_DOCKERFILE` (ADR 0002) and `network: "open"` (ADR 0003) did — each is the simplest thing
that makes this ticket's seven acceptance checks true, not the final design.

## `.crisol/config.toml`'s Gate-ladder rung reads ONE key with a hand-rolled parser

`readRepoGates` (`src/config.ts`) reads `.crisol/config.toml` for a single-line `gates = […]` key
with a small regex-based parser, not a TOML library. Chosen because `package.json` carries no
runtime dependency yet (only `@types/bun`), and the file's eventual full surface — `network`,
`env`, `services` (spec, "Network", "Credentials", "Services") — is each its own later ticket;
pulling in a TOML dependency now to read one key would be dependency weight ahead of the need it
serves. Multi-line arrays and any key besides `gates` are silently ignored, never rejected, so a
repo that later adds `network = […]` beside `gates = […]` is not broken by this ticket's own
parser.

Rejected:
- **A real TOML dependency now** — no second key exists yet to justify it; `parseGatesArray`'s own
  unit test is cheaper to keep correct than a dependency's upgrade surface.
- **A different, simpler file format than TOML** — the spec's own wording already commits to
  TOML-shaped syntax for this file (`network = […]`, `env = ["NPM_TOKEN"]`), so inventing a
  different format here would only have to be migrated away from later, for no benefit now.

## The ceiling (5 iterations / 60 minutes) is overridable per Run, from the CLI, and in `~/.crisol/config`

The spec says the ceiling is "overridable per Run and in `~/.crisol/config`". Both halves now
exist, resolved independently per knob by `resolveCeiling` (`src/run.ts`):

- **Per Run** — `RunOptions.maxIterations` / `RunOptions.ceilingMs`, the same seam ticket 01's own
  `generateRunId`/`ensureImage` test seams already established (a real 60-minute wall clock would
  make the "never converge" and wall-clock-ceiling acceptance checks impractical to run for real in
  the suite). This is also where the CLI's own `--max-iterations <n>` and `--timeout <minutes>`
  land, converting minutes to ms before reaching `ceilingMs`.
- **`~/.crisol/config`** — `readGlobalConfig` (`src/config.ts`), the same hand-rolled,
  single-key-per-line parser as this ADR's first section, for exactly two keys:
  `max_iterations` and `timeout_minutes`. A key this ticket doesn't recognise — a future
  `max_parallel` (q11) — is silently ignored, never rejected, same reasoning as `parseGatesArray`.

Precedence: a per-Run value (flag or direct `RunOptions`) beats the config file beats the
built-in default (5 iterations / 60 minutes), resolved independently per knob — a Run can set one
without touching the other. An invalid value (non-integer, zero, negative) in either the flag or
the config file fails the Run before any side effect, naming the source (the flag, or the config
file's path) and the key, never silently falling back to the default.

`resolveCeiling` is kept as its own pure function, separate from `run()`, so the precedence itself
is a fast unit test and never needs a real Sandbox — only the one acceptance check that actually
exercises `~/.crisol/config` end to end against the Fake Adapter needs Docker.
