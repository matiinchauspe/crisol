# The Claude Code Adapter's Agent layer: non-root, its image build, and attribution-off

Ticket 14 is the first ticket to build a REAL Adapter. Four decisions it had to make that the
spec and crisol ADR 0005 left open — one of them (the non-root user) only surfaced once a real
Claude Code Run was actually attempted, not from reading the spec alone:

## `PreStartDeclaration` gains `ensureImage`, not the plain `image: string` crisol ADR 0005 sketched

ADR 0005's decision snippet sketched `image?: string`, "used instead of `ensureBaseImage()`'s
default tag." That shape doesn't survive contact with how `ensureBaseImage` actually works:
it builds `SKELETON_DOCKERFILE` under whatever tag it's given, so handing it the Claude Code
Adapter's own tag would build the WRONG image under the RIGHT name. Building the real Agent layer
(installing Claude Code, writing its settings) is also inherently async (`docker build` takes
real time), while `declarePreStart()` is sync by ADR 0005's own four-method shape.

`PreStartDeclaration.ensureImage?: () => Promise<string>` resolves both: `declarePreStart()`
synchronously returns a CLOSURE over everything the build needs (the tag, the Dockerfile text),
and `run.ts` calls it only when and if it actually needs the image, reusing the exact shape
`RunOptions.ensureImage` already had as a test seam. `run.ts`'s own precedence becomes
`options.ensureImage ?? preStart.ensureImage ?? ensureBaseImage` — an explicit test override
beats the Adapter's own declaration beats Crisol's plain base image (the fake Adapter, which
declares no `ensureImage` at all).

`docker.ts`'s `ensureBaseImage` is refactored into a thin wrapper over a new, shared
`ensureImageFromDockerfile(tag, dockerfile)` — the cache-or-build primitive (`docker image
inspect` then `docker build -q -t <tag> -`) written once, reused by both the skeleton image and
the Agent layer.

## The Agent layer installs Claude Code via its own native installer, never npm

The npm package (`@anthropic-ai/claude-code`) requires Node.js 22+; Alpine 3.20's `nodejs`
package (the Project layer until ticket 12 exists) is 20.15.1, and pulling in a newer Node just to
run an npm postinstall step that only unpacks a native binary would be a real dependency for no
benefit — the npm package's own docs say the installed `claude` binary "does not itself invoke
Node." Checked directly against Claude Code's own install docs (`code.claude.com/docs/en/setup`,
"Advanced installation options" and "Alpine Linux and musl-based distributions"): the native
installer (`curl -fsSL https://claude.ai/install.sh | bash -s <version>`) takes an explicit
version argument, and Alpine only needs `curl`, `libgcc`, `libstdc++` and `ripgrep` (`apk add`)
at runtime — no Node, no npm. `USE_BUILTIN_RIPGREP=0` is required alongside it, since the
bundled ripgrep targets glibc and Alpine is musl; it rides the same baked `settings.json` as
attribution (below), under its `env` key.

The version pinned is always the HOST's own (`claude --version`, parsed by
`parseClaudeVersionOutput`), never `latest` — ticket 14's own acceptance check. Verified against
the real binary on 2026-11-12 (Claude Code v2.1.283): `claude --version` prints `"2.1.283 (Claude
Code)"`, and `registry.npmjs.org/@anthropic-ai/claude-code/2.1.283` exists, confirming the version
string the host reports is a real, installable release.

## Attribution is disabled by a baked `settings.json`, never a CLI flag or the Preamble

Checked against Claude Code's own settings reference (`code.claude.com/docs/en/settings-reference`):
`includeCoAuthoredBy` is deprecated and ignored once `attribution.commit`/`attribution.pr` is set;
the current key is `attribution: { commit, pr, sessionUrl }`. The Agent layer Dockerfile writes
`/home/agent/.claude/settings.json` with attribution off — a FILE baked into the image at build
time, read by Claude Code as ordinary user settings on every invocation inside the Sandbox, rather
than a `--settings` flag repeated on every `launch`/`resumeWithFeedback` call. This is what "by
configuration inside the Sandbox, not by the Preamble" (ticket 14's own wording) means taken
literally: the Preamble is text the model reads and might not honor; `settings.json` is enforced
by the CLI itself, independent of the model's behavior.

`attribution.commit` and `attribution.pr` take the TRAILER STRING to use, never a boolean — an
empty string is what hides them; `attribution.sessionUrl` is the one boolean field. A first pass
baked all three as `false`; the published JSON Schema
(`json.schemastore.org/claude-code-settings.json`) gives the real shape, and `claude doctor`, run
against that exact file inside a real build of the Agent layer, confirmed it the hard way —
"`attribution.commit`: Expected string, but received undefined" — before the fix. The same
`claude doctor` run against the corrected file reports "No installation issues found," and its
`Search:` line flipped from "OK (bundled)" to "OK (/usr/bin/rg)," which is independent proof the
baked `settings.json` is read and acted on, not merely present and schema-valid.

## Claude Code runs as a non-root `agent` user, never `root`

The first real by-hand Run (Matías) failed at once: `claude exited 1: --dangerously-skip-permissions
cannot be used with root/sudo privileges for security reasons`. The Agent layer's first draft
installed Claude Code under `/root` with no `USER` instruction, so the Sandbox ran it as root —
and root is exactly what an unattended Run (`--dangerously-skip-permissions`, no human to drop the
flag) cannot be. `mattpocock/sandcastle` (prior art this spec already read and deliberately didn't
port wholesale) independently requires the same thing in its own Dockerfile: "A non-root `agent`
user (required — Claude runs as this user)."

The Agent layer now `adduser -D -h /home/agent -s /bin/bash -u 1000 agent`, `USER agent`s before
installing Claude Code (so the native installer's `~/.local/bin`/`~/.local/share` land under
`/home/agent`, not `/root`), and stays that user for `settings.json` too. `startSandbox` needed no
change: `docker exec` already defaults to the image's declared `USER`, so `launch` and
`resumeWithFeedback` run as `agent` for free.

**Verified, not assumed**, against a real build of the corrected image, in throwaway containers
(never the real `claude -p`, never a real token):
- `id` inside a fresh container: `uid=1000(agent) gid=1000(agent)`, never 0.
- `claude --version` and `claude doctor` both run cleanly as that user; `doctor` confirms
  `/home/agent/.claude/settings.json` is the file in effect, not `/root`'s (`ls /root/.claude` is
  `Permission denied` to `agent`, confirming the separation is real, not cosmetic).
- The macOS bind-mount concern this ruling called out by name: on this machine's engine
  (OrbStack), a host directory owned by the host account (uid 501) was bind-mounted into a
  container running as uid 1000 `agent`, and `touch`, `git add` and `git commit` (with
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env, the same wiring `run.ts` already uses) all succeeded — the
  commit is visible from the host afterward. OrbStack does not enforce numeric-UID bind-mount
  ownership the way a native Linux Docker host would (a plain `stat` inside a container reports
  every bind-mounted file as `uid=0 gid=0` regardless of its real host owner); this was checked
  directly rather than assumed, but **only on OrbStack** — Docker Desktop's and Colima's own
  bind-mount implementations were not available to test here and may enforce it differently.

## `cli.ts` gets a `--adapter <fake|claude-code>` flag, defaulting to `fake`

Every pre-existing test (`runCli(["run", "say hello", ...])`, across tickets 01–09) relies on
`crisol run`'s CLI defaulting to the fake Adapter; changing that default would silently make the
whole existing suite call a real Docker image build and, if authenticated, the real agent —
exactly what every ticket's own instructions forbid. `run()` itself keeps defaulting to
`FakeAdapter`, untouched; `--adapter claude-code` is `cli.ts`'s own opt-in, letting a human run
`bun src/cli.ts run "<task>" --adapter claude-code --gate "<cmd>" --json` for ticket 14's
by-hand check without touching any other ticket's tests. Only the flag's PARSING is covered by
the automated suite (missing value, unrecognised name, and the explicit `fake` default) — passing
`--adapter claude-code` itself is never exercised automatically; see `test/claude-code-adapter.test.ts`
for how the real Adapter's logic is tested without Docker or the real `claude` binary instead.

## Rejected

- **Setting `IS_SANDBOX=1` (or `CLAUDE_CODE_BUBBLEWRAP`) to skip Claude Code's own root check
  instead of running as non-root** — this env var exists and genuinely lets
  `--dangerously-skip-permissions` start as root, but it exists for a runtime that is ALREADY
  sandboxed by some other mechanism and is telling Claude Code so; running as root inside the
  Sandbox and then asserting that fact would be the lie it's meant to catch, not a fix for it.
  Running as a real non-root user is what the check is actually asking for.
- **Passing `--settings '{"attribution":...}'` on every `claude -p` invocation** — works, but
  repeats the same JSON blob on every `launch`/`resumeWithFeedback` call for no benefit over
  baking it into the image once; a baked file is also harder for a prompt-injected task to argue
  its way around than a flag the Adapter itself controls per-call.
- **A fifth `Adapter` method for building the image** — ADR 0005 fixed the interface at exactly
  four methods; reusing the existing `ensureImage` SHAPE as an optional field on
  `PreStartDeclaration` keeps that count instead of growing it.
- **Testing the real Agent layer `docker build` in the automated suite** — slow, needs network
  (the native installer downloads over HTTPS), and the dispatched run that built this ticket was
  explicitly told to keep it off the automated gate; only the Dockerfile TEXT (a pure function)
  and the argv-building logic are unit tested, and only the by-hand Run proves the image actually
  builds and runs correctly end to end.
