# Tenaza decides inside the Sandbox, from the host's config and state mounted in

Ticket 15: a Run's reserved actions (a `git push`, a deploy — whatever the human's Tenaza policy
marks) must still reach the human, though the agent runs unattended inside a Sandbox. Amends ADR
0016, whose Tenaza component of the Agent layer's cache key was a fixed placeholder.

## The Claude Code Adapter owns Tenaza

ADR 0005 named Tenaza's mounts as `wireHooks`'s contribution to the `PreStartDeclaration`, so the
Adapter, not `run.ts`, decides it. `ClaudeCodeAdapter.declarePreStart` checks whether the host's
Tenaza home exists — `TENAZA_HOME`, else `~/.tenaza`, the same lookup Tenaza itself makes
(`src/tenaza.ts`). Present, it:

- mounts `config/` read-only and `state/` read-write at `/home/agent/.tenaza`, the agent's own
  `TENAZA_HOME`, so the agent cannot rewrite `policy.toml` to authorize itself, while every
  decision, Inbox item and session event lands in the host's own `state/`;
- creates either dir when missing, since `docker run --mount type=bind` refuses a source that does
  not exist, and skipping the config mount would leave no read-only guard at all;
- builds the Agent layer with Tenaza's Linux binary and its Claude Code hooks baked into
  `settings.json`.

## Hooks decide locally, never over HTTP

The hooks are the events and matchers of Tenaza's own Claude Code plugin (`hooks/hooks.json`):
`tenaza hook claude` on every event, `PreToolUse` matched to `Bash|mcp__.*` with Tenaza's 240 s
timeout, `Notification` to `permission_prompt|idle_prompt`. The binary reads the mounted policy
and writes the mounted state itself; nothing inside the Sandbox calls the host daemon, so a
reserved action is decided whether or not the daemon is running. Telling the human about a new Inbox item is the daemon's job, on
the host, reading the same `state/`.

The plugin's `PreToolUse` guard for a missing binary is left out: the binary is baked into the
same layer as the hooks, and the guard's single quotes cannot ride inside the single-quoted
`printf` that writes `settings.json` (ADR 0008).

## The binary: Tenaza v0.5.2's musl builds, checksum-verified

Every Sandbox is Alpine, and Tenaza v0.5.0's Linux builds are glibc: they fail there with
`not found`, and with `gcompat` with a relocation error. v0.5.2 publishes
`tenaza-linux-{arm64,x64}-musl`. The Agent layer picks the asset from `uname -m` at build time —
so one Dockerfile, and one cache key, serves either arch — downloads it from the release, checks
its sha256 with `sha256sum -c`, and adds `libgcc libstdc++`, which Bun's musl build links
dynamically. `TENAZA_RELEASE` pins the version, asset names and sums together.

## The cache key carries the real version

`buildAgentLayerSpec` takes the release itself in place of ADR 0016's `tenazaVersion` string and
hashes `tenaza.version`; a Run without Tenaza still hashes the placeholder `none`, so a layer
without it keeps the tag it always had. A new pinned version changes the tag and the download URL,
so the next Run rebuilds the layer.

## The Run is labelled with the host repo, before the agent starts

Tenaza's board groups sessions by a `project` label, which a session sets by running
`tenaza label project=<path>` through its `PreToolUse` hook. Inside the Sandbox the agent's cwd is
the Clone, never the host repo, so the Adapter labels the session itself: it picks the session id
(`crypto.randomUUID()`), hands `tenaza hook claude` the same `PreToolUse` payload a labelling
`Bash` call would produce, with the host repo's git root as the value, and launches `claude` with
`--session-id` set to that id. `AdapterContext` gains `hostRepoPath` for it. The label is
best-effort: a failed label costs the board grouping, never the guard. A host path with whitespace
is left unlabelled, since `tenaza label` splits its pairs on whitespace and would cut the path.

## Without Tenaza, the Run says so once

A Tenaza-less host still runs, with neither mounts nor binary nor hooks. `PreStartDeclaration`
gains `unguarded`, the reason nothing inside the Sandbox decides reserved actions;
`run()` calls a new `onUnguarded` once with `This Run has no reserved-action guard: <reason>.`
before the Run waits for a Slot, and the CLI writes it to stderr, which a detached Run's log
carries too. The scripted stand-in Adapter leaves `unguarded` unset: it attempts no reserved
action, and every existing test asserting an empty stderr stays true.

## Rejected

- **The no-guard line for every Adapter without Tenaza** — would print for the stand-in, which
  takes no reserved action, and break every test that pins an empty stderr.
- **Detecting Tenaza in `run.ts`** — the hook wiring is the Adapter's pre-start contribution (ADR
  0005); a second Adapter wires its own agent's hooks.
- **Hooks calling the host daemon over HTTP** — the ticket rules it out, and a daemon that is not
  running would leave the agent unguarded.
- **Tenaza v0.5.0's glibc builds with `gcompat`, a glibc loader or `patchelf`, building Tenaza from
  source in the layer, or a glibc Sandbox** — the first fails to load, the next two are fragile,
  and the last two contradict the pinned release or rewrite tickets 12 and 14.
