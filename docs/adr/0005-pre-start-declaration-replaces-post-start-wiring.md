# A pre-start declaration replaces `authenticate`/`wireHooks` running after the Sandbox starts

Supersedes, in part, docs/adr/0001-adapter-takes-a-sandbox-handle.md: `authenticate` and
`wireHooks` no longer receive a live `AdapterContext` and no longer run after `docker run`. They
now contribute to one `PreStartDeclaration` (`src/adapter.ts`) that `startSandbox` (`src/docker.ts`)
consumes BEFORE the container exists. `launch`, `reportCompletion` and `resumeWithFeedback` are
unchanged — they still receive the live `AdapterContext` the original ADR described.

## Why ticket 01's original shape was already wrong for later tickets

Ticket 01 originally called `adapter.authenticate(ctx)` and `adapter.wireHooks(ctx)` AFTER
`startSandbox` had already run `docker run` and handed back a live `Sandbox` — reasonable for the
fake Adapter, which does nothing in either method, but not survivable once a real Adapter exists:

- **Ticket 08 (credentials)**: the real Adapter's `CLAUDE_CODE_OAUTH_TOKEN` must be Sandbox *env*,
  and container env is fixed at `docker run` time — there is no `docker exec`-time equivalent of
  adding an env var to an already-running container.
- **Ticket 15 (Tenaza inside)**: Tenaza's `~/.tenaza/config:ro` and `~/.tenaza/state:rw` are bind
  mounts, and Docker bind mounts are likewise fixed at container creation — `wireHooks` running
  post-start could never add one.
- **Ticket 14 (Claude Code Adapter) / 12 (two-layer image)**: the Agent layer image an Adapter
  contributes is the `image` `docker run` is built from — necessarily decided before that command
  runs, not after.

Round-1 review flagged this as a contradiction worth fixing now rather than carrying it into three
separate tickets later, each of which would otherwise need to retrofit the same pre-start plumbing
under time pressure. Matías decided: fix the shape in ticket 01.

## Decision

`Adapter` (`src/adapter.ts`) keeps four methods: one pre-start declaration plus the three runtime
points.

```ts
interface PreStartDeclaration {
  envNames: readonly string[];   // authenticate's contribution — NAMES only, never values
  mounts: readonly MountSpec[];  // wireHooks's contribution — Tenaza's config/state, etc.
  image?: string;                // the Agent layer image (tickets 12/14/17); undefined = Crisol's base image
}

interface Adapter {
  declarePreStart(): PreStartDeclaration;
  launch(ctx: AdapterContext): Promise<void>;
  reportCompletion(ctx: AdapterContext): Promise<boolean>;
  resumeWithFeedback(ctx: AdapterContext, feedback: string): Promise<void>;
}
```

The spec's five points stay identifiable: `declarePreStart`'s return fields are each commented
with the point they come from (`envNames` ← authenticate, `mounts` ← wireHooks), so a reader can
still find each of the five without the two having their own methods. `startSandbox`
(`src/docker.ts`) consumes the declaration directly:

- `envNames` becomes bare `-e NAME` flags on `docker run` argv — the secret's VALUE is never
  written to argv (visible via `ps`, shell history, or Crisol's own logs); docker resolves each
  name from the spawned `docker` process's own environment instead (`Bun.spawn(..., { env:
  process.env })`).
- `mounts` becomes additional `-v hostPath:containerPath[:ro]` flags alongside the Clone's own
  mount.
- `image`, when set, is used instead of `ensureBaseImage()`'s default tag.

The fake Adapter (`src/adapters/fake.ts`) declares `{ envNames: [], mounts: [] }` — it still
contributes nothing, same as before, just through the new shape.

## Rejected

- **Five separate pre-start methods** (`authenticate(): EnvDeclaration`,
  `wireHooks(): MountDeclaration`, `agentImage(): string | undefined`, plus the three runtime
  points) — keeps the five points as five methods literally, but scatters what is really one
  decision (everything `startSandbox` needs before it runs) across three call sites `run.ts` would
  have to compose itself every time. One declaration, clearly commented per field, reads better and
  composes once.
- **Leaving `authenticate`/`wireHooks` as post-start no-ops forever and inventing a SEPARATE
  pre-start interface for the token/mounts/image** — would leave two different ways an Adapter
  expresses intent for what is conceptually the same five-point contract; confusing for ticket
  14's real Adapter to implement correctly.
- **Passing secret values directly as `-e NAME=value`** — rejected outright: it would put a
  credential on the docker CLI's argv, visible to anything that can read this host process's
  command line (`ps aux`, shell history, Crisol's own debug logs). `-e NAME` (bare) plus the
  spawned process's own env is the only shape that keeps the value off argv entirely.
