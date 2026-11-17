# Services share the Run's network (or a bare one of their own), and health-gate on `docker run --health-cmd`

Ticket 11 builds `.crisol/services.yml` (spec q10): one instance of each declared service per Run,
reachable by service name, the agent launching only once every healthcheck passes.

## `.crisol/services.yml` is read by the same kind of hand-rolled parser as `config.toml`

The file is YAML, but a *restricted* compose subset — only `image`, `environment`, `command` and
`healthcheck` are ever allowed on a service. Rather than add a YAML library dependency, `services.ts`
hand-rolls a minimal block parser (mappings, block/flow sequences, scalars) over exactly the shapes
that grammar needs, the same bet crisol ADR 0006 already made for `.crisol/config.toml`'s `gates`
and `env` arrays. It is narrower than real YAML on purpose: no trailing-comma flow sequences, no
anchors, no multi-document streams. Every unknown service key or healthcheck key is rejected by
name before any side effect, read directly off this parser's output.

## A service joins the Run's existing network; open mode gets a bare one of its own

When a wall exists (`allowlist` or `learn`), services join that same `crisol-net-<id>` the Sandbox
is already on — no second network, no extra `docker network connect`. `--network open` stands up no
wall at all, so a Run whose repo declares a service creates `crisol-net-<id>` bare (via
`network.ts`'s now-exported `createInternalNetwork`, no proxy attached). Reusing that exact name and
label means `crisol recover`'s existing unconditional `removeNetworkByRunId` sweep, and its
label-based `removeRunSandboxes` container sweep, already cover a dead Run's service containers and
bare network with zero changes to `recover.ts`.

Each service container gets `--network-alias <service-name>` rather than relying on its container
name (`crisol-svc-<id>-<service-name>`, unique Run-wide to avoid a Docker-wide name collision with a
parallel Run's same-named service). Verified live: two different `--internal` networks, each
carrying a container aliased `db`, resolve `db` to a *different* IP on each — Docker's embedded DNS
is scoped per network, so two parallel Runs each reach their own "db" with no cross-talk, confirmed
with real containers before relying on it.

### Open mode plus a declared service: the Sandbox joins a second network after creation, not at `docker run` time

`docker run` accepts several `--network` flags at creation time — confirmed live between two
user-defined networks — but refuses outright to mix the default bridge with a user-defined network
in that same list (`conflicting options: cannot attach both user-defined and non-user-defined
network-modes`, the daemon's own message, reproduced live). Open mode's Sandbox needs exactly that
mix: the default bridge for its internet, a bare internal network for the service. The fix is the
same one the Allowlist proxy already uses for its own second leg (crisol ADR 0012): start normally,
then `docker network connect` the second network once the container exists. That function
(`connectNetwork`) now lives in `docker.ts`, exported, and `network.ts`'s own proxy join calls it too
instead of carrying a near-identical private copy. `startSandbox` takes an optional
`servicesNetwork` and only performs this extra join when it differs from the primary `network` — the
common allowlist/learn case, where services already share the wall's network, triggers no second
call at all.

## Health-gating reads Docker's own `--health-cmd`, polled through `docker inspect`

`docker run --health-cmd <string> --health-interval … --health-retries …` adds a container
healthcheck without needing it baked into an image — confirmed live against `postgres:16-alpine`
(`pg_isready`, `--health-retries 1 --health-interval 1s` → `unhealthy` in about two seconds) and
against a plain `exit 1`. `--health-cmd` only ever runs a shell string: compose's `CMD-SHELL`
passes its one argument straight through; `CMD`'s exec-form argv is shell-quoted and joined, which
runs the same program the exec form would have as long as no argument needed shell-less exec
semantics specifically (none of this ticket's services — `pg_isready`, `redis-cli ping` — do).
`NONE` sets no health flags, so that service is never gated.

`waitHealthy()` polls each gated service's `docker inspect --format {{.State.Health.Status}}` every
500ms until every one reports `healthy`, throws naming the first to report `unhealthy`, or throws on
a 10-minute backstop ceiling — a safety net only, since a service's own `--health-interval`/
`--health-retries` is what actually settles `starting` into a terminal status, verified live. The
failure happens before `startSandbox`, so a never-healthy service fails the Run with `iterations: 0`
and no agent launch, which the suite also pins (`launched` stays `false`).

## The postgres entrypoint's own delay trick proves start-ordering, not a race

"The agent starts only after the healthcheck passes" is pinned without a flaky race by giving the
declared service's `command` a deliberate delay before its real startup
(`sh -c "sleep 3 && docker-entrypoint.sh postgres"`) — the official image's own entrypoint script
execs its arguments directly whenever the first one isn't literally `postgres`, so the sleep runs
first and the real init (and therefore `pg_isready` passing) only begins after it, confirmed live.
The agent's very first action is a raw TCP probe of `db:5432`; it only sees `connected` if Crisol
genuinely waited past the delay, not merely if it got lucky on timing.

## Rejected

- **A YAML library dependency** — see above; the restricted grammar is narrow enough that a
  dependency buys little over the same hand-rolled approach `config.toml` already uses, and adds the
  project's first runtime dependency for a single file format.
- **Multiple `--network` flags at `docker run` creation time for the open-mode case** — works
  between two user-defined networks (confirmed live) but not between the default bridge and a
  user-defined one (confirmed live, with the daemon's own refusal), so it cannot cover open mode's
  actual combination.
- **A `phase`-free global proxy-style container per service across every Run** — rejected the same
  way crisol ADR 0012 rejected one shared network and proxy: it would make one Run's service visible
  or reachable from another's Sandbox, and two Runs needing the same service name could not coexist.
