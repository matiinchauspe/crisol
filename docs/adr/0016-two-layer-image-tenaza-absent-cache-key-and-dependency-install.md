# Ticket 12's two-layer image, the Tenaza-absent cache key, and dependency install

Ticket 12 replaces crisol ADR 0002's placeholder (`SKELETON_DOCKERFILE`/`SKELETON_IMAGE_TAG`,
cached by one fixed tag) with the spec's real design (q3, q17): a Project layer the repo may
override, an Agent layer Crisol always builds on top, and per-Run dependency installs behind the
wall.

## The Project layer is read from the host working tree, resolved before the Adapter is asked

`readProjectDockerfile`/`resolveProjectLayer` (`src/project-layer.ts`) read `.crisol/Dockerfile`
from the host repo's working tree — the same rung every other `.crisol/` declaration already
reads from (`readRepoGates`, `readRepoServices`), not from the Clone, which doesn't exist until
later. Absent, the Project layer is Crisol's own default (`DEFAULT_PROJECT_IMAGE_TAG`,
`src/docker.ts`); present, it is cached by a hash of its own text (`crisol-project:<hash>`),
never by branch or commit, so the same Dockerfile reuses one image everywhere.

`Adapter.declarePreStart` gains a `projectImage: string` parameter — the resolved Project
layer's tag — so the Claude Code Adapter's Agent layer can build `FROM` it instead of the
`SKELETON_IMAGE_TAG` it hardcoded before. `run.ts`'s own `ensureImage` now ensures the Project
layer first (whatever its origin), then calls the Adapter's own `ensureImage` (the Agent layer,
if the Adapter declares one) on top — the Agent layer's `docker build` would otherwise try to
pull its `FROM` base from a registry that doesn't carry it. `options.ensureImage` (the existing
test seam) still bypasses both stages outright, exactly as before.

## Crisol's own default Project layer gains the spec's full toolchain

The skeleton image's `git bash curl` placeholder becomes the spec's own list: `nodejs npm
python3 github-cli ripgrep` via `apk`, plus `bun` via its official installer
(`BUN_INSTALL=/usr/local` before the curl script, confirmed live: installing under `/root`
instead left the binary unreadable to the Agent layer's later non-root `agent`, since `/root` is
`0700` — `/usr/local` is world-readable and already on `PATH`, so no extra `ENV PATH` line is
needed). `pnpm` and `yarn` are deliberately NOT baked in — the spec's own list names git, Node,
Bun, Python, gh, rg and nothing else; a repo whose lockfile needs pnpm or yarn supplies its own
`.crisol/Dockerfile`. Crisol's dependency-install step still SELECTS `pnpm`/`yarn` correctly from
their lockfiles — only whether the binary exists in the image is left to the Project layer, same
as any other tool a repo's own toolchain must provide.

This is a real size and first-build-time increase (~400MB, confirmed live; the spec's own
"Further Notes" already expects 1–2GB and "the first Run on a machine pays the build"). Every
later Run reuses the cached tag, and so does every later test within one `bun test` invocation —
only whichever test calls `ensureDefaultProjectImage` (`ensureBaseImage` before this ticket)
FIRST pays the real `apk` install plus `curl`-piped installer; Bun runs a file's own tests in
source order, so only the FIRST such call *within each file* can ever be that one, but WHICH
file gets there first across the whole suite is not something to rely on (confirmed live:
re-running `bun test` with the same files in a different argument order, and a full-suite run
captured through `--reporter=junit`, both show a file order that is neither alphabetical nor
stable run to run). The repo's own practice for a slow Docker test — a timeout as the third
`test()` argument — already covers every test that reaches this path except one:
`test/teardown.test.ts`'s first test, calling `ensureDefaultProjectImage` directly at `30_000`,
a value set before this ticket's image grew heavier. That one test moves to `60_000`, matching
the convention's own majority value; every other Docker-touching test either already carries an
adequate timeout, fails before ever reaching the image build (confirmed by reading `prepareRun`'s
own order — git identity, task/template validation, CLI argument parsing and declared-secret
checks all run before `assertDockerReachable`/the image ensure), or overrides `ensureImage`/
`ensureProxyImage` with a synthetic failure that `Promise.all` rejects on before the real build
can matter. Proven by removing `crisol-base:0.2.0` (and any `crisol-project:<hash>` it derives)
and running plain `bun test` from that cold cache: still 411 pass / 0 fail.

## The Agent layer's cache key is a real hash now, not the bare Claude Code version

`buildAgentLayerSpec` tagged the image `crisol-agent-claude-code:<version>` — version only,
ignoring the Project layer entirely. It now tags `crisol-agent-claude-code:<hash>`, the hash
covering exactly the spec's three inputs: Project layer image, agent version, Tenaza version
(`contentHash`, `src/docker.ts` — `Bun.CryptoHasher("sha256")`, verified live, sliced to 12 hex
characters, the same "short and stable, not a security boundary" bet `generateRunId` already
makes). A version bump, OR a Project layer change, now correctly invalidates the Agent layer —
the version-only tag never would have.

## Tenaza's version, absent ticket 15: a fixed placeholder, not a host probe

The spec's cache key names "Tenaza version" as an input, but ticket 15 (the Linux Tenaza binary
this Agent layer would bundle) is explicitly not built here — nothing on the host's
`~/.tenaza/*` is read, mounted, or installed by this ticket. Two shapes were open:

1. Omit the Tenaza component from the hash entirely until ticket 15 exists.
2. Carry a FIXED placeholder string (`TENAZA_VERSION_PLACEHOLDER = "none"`,
   `src/adapters/claude-code.ts`) as the third hash input, always, whether or not Tenaza is
   installed on the host.

(2) was chosen. The Agent layer does not actually vary with the host's Tenaza installation
today — there is no code path that would bundle a different binary — so probing
`~/.tenaza/state`/`TENAZA_HOME` now would record a signal the image's own content does not yet
act on, which is worse than not probing: a cache key that LOOKS sensitive to Tenaza while the
build ignores it is actively misleading. The fixed placeholder keeps the hash's SHAPE already
matching the spec's three-input description, so the day ticket 15 lands a real version and the
Adapter starts reading it, the key changes automatically and once — correctly, since the image's
content is changing for the real first time then. `buildAgentLayerSpec`'s own tests pin that an
explicit, different Tenaza version does change the tag, so the day ticket 15 supplies a real one
in place of the placeholder, nothing here needs to change.

### Ticket 15 amends this (2026-11-22): the real version replaces the placeholder

Ticket 15 landed the Linux Tenaza binary this section waited for. `buildAgentLayerSpec` now takes
the pinned release (`tenaza?: TenazaRelease`) in place of `tenazaVersion?: string` and hashes its
version when the host has Tenaza; without it, the placeholder `none` is still hashed, so a
Tenaza-less layer keeps its tag. The host's Tenaza home is now probed, by the Adapter, because the
image's content does vary with it: the binary and its hooks are baked only when it exists. See
ADR 0028.

## Dependency install: detected from the Clone, run as Crisol's own infra step, before the agent

`detectPackageManager` (`src/dependencies.ts`) reads the CLONE, not the host working tree — the
lockfile that matters is the one at `baseSha`, which the host's own checkout may not be on (a
difference from how `.crisol/` declarations are read, deliberate: those are repo-level
configuration, a lockfile is the commit's own dependency graph). First match wins, in the order
the ticket itself lists: `bun.lock`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`.

The install runs AFTER the Sandbox starts and BEFORE the agent launches — mirroring where
Services health-gate (crisol ADR 0015): a broken install fails the Run with `iterations: 0`,
never spending one on it, the same reasoning that already governs a never-healthy service.

Each manager's own cache flag was verified against its real `--help` output, not assumed:
`bun install --cache-dir`, `pnpm install --store-dir`, `npm ci --cache` (a general `npm` config
flag, not `ci`-specific — `npm ci --help` carries no cache flag of its own), `yarn install
--cache-folder`. All four point into subdirectories of ONE shared, long-lived Docker volume
(`crisol-pkg-cache`, auto-created by `docker run --mount type=volume,source=...` on first use —
confirmed live, so there is no separate `ensureVolume`), per the spec's "a shared volume across
Runs; the install itself never is." The install itself writes into the Clone's own bind-mounted
`node_modules`, so it is never shared between Runs by construction — each Run clones fresh.

### The cache volume is long-lived and may be owned by a different Run's container user

A FakeAdapter Run's default image carries no `USER` (root); the Claude Code Agent layer runs as
non-root `agent` (crisol ADR 0008). The SAME cache volume serves both kinds of Run over its
life, so a later Run's container user may not own what an earlier one left behind.
`docker exec -u root` — confirmed live to work on ANY image regardless of its own declared
`USER`, root (uid 0) always existing — lets Crisol `mkdir`+`chmod 0777` the cache directories
before every install, whatever user that Sandbox itself runs as. This is NOT exposed through the
`Sandbox.exec` interface an Adapter uses (which must stay non-privileged); `execAsRoot`
(`src/docker.ts`) is a separate, narrower export `run.ts`'s own infra code calls directly, never
handed to an Adapter.

## Deliberately not built: a `phase` field on `blocked`

Crisol ADR 0012 named "dependency installs, before the agent starts" as the phase ticket 12 would
make distinguishable, and flagged `blocked`'s `phase` field as landing with it. It is NOT added
here: none of ticket 12's own six acceptance boxes ask for it, and building it correctly needs
reading the proxy's log TWICE (a snapshot right after install, a full read before teardown) and
diffing per-host counts across the two reads — real complexity for a field nothing in this
ticket's own scope consumes. `Blocked` is left exactly as ADR 0012 shaped it
(`{ host, port?, count }`), still open to a `phase?` addition later without a breaking change,
per the stable JSON contract's own "fields are only added" rule.

## Rejected

- **Reading the Project layer's `.crisol/Dockerfile` from the Clone instead of the host working
  tree** — would be MORE correct (exactly `baseSha`'s content) but inconsistent with every other
  `.crisol/` read in the codebase, none of which wait for the Clone; fixing that inconsistency
  project-wide is not this ticket's call.
- **Probing the host's `~/.tenaza` for a real Tenaza version** — rejected above: the Agent layer
  does not vary with it yet, so the signal would be fake sensitivity.
- **Baking `pnpm`/`yarn` into the default Project layer** — the spec's own toolchain list does
  not name them; a repo needing them supplies its own `.crisol/Dockerfile`.
- **A general `MountSpec` variant for the cache volume** — kept as a separate, parallel
  `VolumeMountSpec`/`volumeMounts` instead, since the existing `MountSpec` is bind-mount-shaped
  (`hostPath`) throughout the Adapter/Services call sites that already use it, and a volume mount
  has no host path at all.
- **`ensureVolume` as its own function** — `docker run --mount type=volume,source=<name>` already
  auto-creates a missing volume, confirmed live; a wrapper would duplicate what Docker already
  does idempotently.
- **`package.json`'s `test` script gaining `--timeout 30000`** — the first attempt at the
  cold-cache fix above. Caught in review: the repo's own gate is plain `bun test`
  (`gates = ["bun test", ...]`), which never reads `package.json`'s `test` script at all, so the
  fix never reached it.
- **`bunfig.toml`'s `[test] preload`, building the default image before any test file runs** —
  the SECOND attempt, and it did reach the gate (confirmed: plain `bun test` passed from a cold
  image cache). Caught in review anyway: a preload runs for EVERY `bun test` invocation,
  including `bun test test/dependencies.test.ts` — a pure-unit file that touches neither Docker
  nor the image today. The preload would have made that file, and every other Docker-free one,
  silently start requiring a running Docker engine and a ~400MB build — a real regression the
  per-test-timeout fix below does not cause, since a file that never calls the image-ensure path
  is simply never exposed to its timeout.
