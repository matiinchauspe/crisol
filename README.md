<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/crisol-dark.svg">
    <img src="assets/crisol-light.svg" alt="Crisol" width="200">
  </picture>
</p>

<h1 align="center">Crisol</h1>

<p align="center">
  <strong>Run one Task in a container, unattended, and get back exactly one branch.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-2dd4bf" alt="version 0.1.0">
  <img src="https://img.shields.io/badge/status-walking%20skeleton-f59e0b" alt="status: walking skeleton">
  <img src="https://img.shields.io/badge/platform-macOS-8b93a0" alt="platform macOS">
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1e1" alt="runtime Bun">
  <img src="https://img.shields.io/badge/license-MIT-34d399" alt="license MIT">
</p>

---

A *crisol* (crucible) holds the fire while it works. Crisol does the same for a coding agent. It
clones your repo, runs the agent inside a Docker **Sandbox** that cannot touch your host, and
leaves **one named branch** in your repo when it is done. That happens whether the Run succeeded
or failed. Your working tree is never touched.

```console
$ crisol run "fix the login bug with + in emails" --json
{"run":"9f496a56","branch":"crisol/9f496a56","base":"main@a2689ba","status":"unverified", …}
```

> [!NOTE]
> **Crisol is a walking skeleton.** Every stage of a Run below works end to end today, including
> Gates, converge and least-privilege credentials. `crisol run` still defaults to a scripted
> stand-in Adapter; the real Claude Code Adapter exists (`--adapter claude-code`) but isn't the
> default yet, and the network wall is still open. See [Roadmap](#roadmap).

## Why

You can tell an agent to work on its own, but that is only safe if nothing it does can leak out.
Crisol keeps a Run apart from your host in three ways:

- **Its own Clone.** A Run never works in your checkout or a worktree. It gets a fresh clone that
  shares no `.git` and no objects with your repo
  ([ADR 0004](docs/adr/0004-clone-copies-objects-no-hardlinks.md)).
- **Its own Sandbox.** The agent runs in a container, and the only part of your machine it can see
  is that Clone.
- **One way back.** The only thing that returns to your repo is a branch, brought back by
  **Fetch-back**. Fetch-back runs `git fetch`; it never merges and never touches a working tree.

## How a Run works

```mermaid
flowchart LR
    A["crisol run &quot;task&quot;"] --> B["Validate<br/>base, branch name, Docker"]
    B --> C["Clone<br/>~/.crisol/runs/&lt;id&gt;/repo"]
    C --> D["Cut branch<br/>crisol/&lt;id&gt; from base"]
    D --> E["Sandbox<br/>Clone mounted, agent works & commits"]
    E --> X["Converge<br/>Gates run; red resumes with feedback"]
    X --> F["Teardown<br/>container removed"]
    F --> G["Fetch-back<br/>branch lands in your repo"]
    G --> H["Run result<br/>JSON"]
```

1. **Validate first.** Crisol checks the base ref, the branch name and Docker before it touches
   anything, so an invalid Run leaves nothing behind.
2. **Clone and cut.** Crisol clones your repo with `git clone --no-local`. That copies only the
   objects reachable from your branches, tags and `HEAD`, so a dropped stash never gets into the
   Clone. Then it cuts `crisol/<id>` (or your `--name`) from the base.
3. **Sandbox.** The Clone is bind-mounted into a container at the same absolute path. The Adapter
   does the work and commits there.
4. **Converge.** Crisol — never the agent — decides done. It runs every declared Gate; any red one
   resumes the same session with the failing command and its output, up to a ceiling (5 iterations
   or 60 minutes). All green is `verified`; no Gate declared anywhere is `unverified`; hitting the
   ceiling is `not-converged`.
5. **Teardown and Fetch-back.** The container is removed, and the branch is fetched back into
   your repo. If the Run fails, Fetch-back still runs, so no work is lost. If it fails too, you
   see both errors.

## Requirements

| | |
|---|---|
| **OS** | macOS (Linux is planned) |
| **Runtime** | [Bun](https://bun.sh) |
| **Containers** | A running Docker engine: OrbStack, Docker Desktop, or Colima |
| **Repo** | Any git repo with at least one commit |

## Quick start

```sh
git clone https://github.com/matiinchauspe/crisol.git
cd crisol && bun install

# from inside any git repo you want to run against:
bun /path/to/crisol/src/cli.ts run "say hello" --json
```

To get a standalone `crisol` binary instead, run `bun run build`. It writes `dist/crisol`.

## Usage

```
crisol run "<task>" [--json] [--base <ref>] [--name <branch>] [--gate <cmd>]... [--max-iterations <n>] [--timeout <minutes>] [--adapter <fake|claude-code>]
crisol auth
```

| Flag | Default | What it does |
|---|---|---|
| `--base <ref>` | your current `HEAD` | Branch, tag or sha to cut the Run's branch from. It must be reachable from a local branch, a tag or `HEAD`, because that is all the Clone receives. To use `origin/main`, check it out or fast-forward a local branch onto it first. |
| `--name <branch>` | `crisol/<id>` | The branch name the Run leaves in your repo. Refused before anything happens if it clashes with an existing branch, a tag, or a branch path (for example `feat` vs `feat/x`). |
| `--gate <cmd>` | none | A command whose exit code decides whether the work is right. Repeatable. Any `--gate` replaces your repo's own `.crisol/config.toml` Gates entirely — it never merges with them. |
| `--max-iterations <n>` | `5` | Overrides how many Gate-fail-then-resume attempts this Run gets before `not-converged`. Must be a positive integer. |
| `--timeout <minutes>` | `60` | Overrides the wall-clock ceiling for this Run, in minutes. Must be a positive integer. |
| `--adapter <fake\|claude-code>` | `fake` | Which Adapter runs the Task. `fake` is the suite's own scripted stand-in; `claude-code` runs the real Claude Code Adapter (`crisol auth` first — see [Credentials](#credentials)). |
| `--json` | off | Print the Run result as JSON instead of one line. |

A repo can declare its own Gates once, in `.crisol/config.toml`:

```toml
gates = ["bun test", "bun run typecheck"]
```

### Credentials

By default, no secret enters the Sandbox at all — the scripted stand-in Adapter declares none.
The real Claude Code Adapter (`--adapter claude-code`) declares exactly one,
`CLAUDE_CODE_OAUTH_TOKEN`, resolved from `crisol auth`'s Keychain entry below — run that first, or
the Run fails before anything happens, naming it. A repo that needs another secret declares it by
NAME, never by value, in the same `.crisol/config.toml`:

```toml
env = ["NPM_TOKEN"]
```

`NPM_TOKEN` is then read from your own shell's environment at launch — export it before running
`crisol run`. A name declared but missing from your environment fails the Run before anything
happens, naming it. Nothing from `$HOME` is ever mounted (no `~/.gitconfig`, `~/.ssh`,
`~/.config/gh`, `~/.aws`, `~/.claude`), and no push is possible from inside a Sandbox — the only
way a Run's work reaches your repo is Fetch-back.

```
crisol auth
```

Obtains a Claude Code OAuth token (wrapping `claude setup-token`) and stores it in Crisol's own
macOS Keychain entry, behind `SecretStore` — never on disk, never in your shell's history. The
Claude Code Adapter resolves `CLAUDE_CODE_OAUTH_TOKEN`'s value from there, the same way a
repo-declared secret resolves from your shell's environment. The Agent layer it runs in installs
the same Claude Code version as your host (`claude --version`) under a non-root `agent` user
(Claude Code itself refuses `--dangerously-skip-permissions` as root), and disables commit/PR
attribution by configuration inside the Sandbox — never by asking the model.

### The ceiling

A Run stops resuming once either of two ceilings hits first: 5 iterations, or 60 minutes of wall
clock. Both defaults are overridable, independently, in three layers — `--max-iterations`/
`--timeout` beat `~/.crisol/config`'s own `max_iterations`/`timeout_minutes` beat the built-in
default:

```toml
# ~/.crisol/config
max_iterations = 10
timeout_minutes = 90
```

An invalid value (anything other than a positive integer) in either the flag or the config file
fails the Run before anything happens, naming the flag — or the config file's path — and the key.

### The Run result

The fields are only ever added within 0.x, never renamed or removed:

```json
{
  "run": "9f496a56",
  "branch": "crisol/9f496a56",
  "base": "main@a2689ba",
  "status": "verified",
  "iterations": 2,
  "gates": [{ "cmd": "bun test", "ok": true }],
  "network": "open",
  "blocked": [],
  "warnings": []
}
```

`status` is `verified` once every declared Gate is green, `not-converged` (with
`reason: "ceiling"`) if it never gets there within the ceiling (5 iterations or 60 minutes by
default — see [The ceiling](#the-ceiling)), and `unverified` when no Gate is declared anywhere —
the CLI's `--gate`, else the repo's own `.crisol/config.toml`.
A red Gate resumes the same agent session with its failing command and output; `iterations`
counts how many attempts that took. `network` reports `open` until the network wall lands
([ADR 0003](docs/adr/0003-run-result-reports-network-open-until-the-wall-exists.md)).

### Where things live

```
~/.crisol/                 # override with CRISOL_HOME
├── config                 # optional: max_iterations / timeout_minutes overrides
└── runs/<id>/
    ├── repo/              # the Run's Clone
    ├── log                # timestamped log of every stage
    └── result.json        # the Run result
```

## Roadmap

v1 is built as 18 tracer-bullet tickets. Each one leaves Crisol working end to end.

| # | Ticket | |
|---|---|---|
| 01 | Walking skeleton | ✅ |
| 02 | Gates and converge | ✅ |
| 03 | Slots and fan-out | |
| 04 | Fetch-back on every exit, and recover | |
| 05 | Detach, status, logs | |
| 06 | Network wall | |
| 07 | Editable Allowlist, learn and open | |
| 08 | Credentials | ✅ |
| 09 | Commits | |
| 10 | Text input | |
| 11 | Services | |
| 12 | Two-layer image and dependencies | |
| 13 | Provider failure and capacity | |
| 14 | Claude Code Adapter | ✅ |
| 15 | Tenaza inside | |
| 16 | `crisol gc` | |
| 17 | `crisol init` | |
| 18 | Release 0.1.0 | |

## Vocabulary and decisions

Crisol uses a small, strict vocabulary: **Run**, **Task**, **Sandbox**, **Clone**, **Fetch-back**,
**Gate**, **Adapter**, **Secret**, **SecretStore**. Each term is defined in
[`docs/GLOSSARY.md`](docs/GLOSSARY.md). The decisions behind Crisol's shape are recorded in
[`docs/adr/`](docs/adr/):

- [0001](docs/adr/0001-adapter-takes-a-sandbox-handle.md): the Adapter takes a Sandbox handle, not a raw container id
- [0002](docs/adr/0002-ticket-01-sandbox-image-is-a-placeholder.md): ticket 01's Sandbox image is a placeholder
- [0003](docs/adr/0003-run-result-reports-network-open-until-the-wall-exists.md): the Run result reports `network: "open"` until the wall exists
- [0004](docs/adr/0004-clone-copies-objects-no-hardlinks.md): the Clone copies git objects and never shares them with the host
- [0005](docs/adr/0005-pre-start-declaration-replaces-post-start-wiring.md): a pre-start declaration replaces post-start wiring
- [0006](docs/adr/0006-ticket-02-gate-ladder-and-ceiling-are-placeholders.md): ticket 02's `.crisol/config.toml` parser is a hand-rolled placeholder; the ceiling override (CLI flags and `~/.crisol/config`) is implemented
- [0007](docs/adr/0007-ticket-08-credential-placeholders.md): `crisol auth` keeps the token off every spawned process's argv, verified against the real `security` CLI; its assumption about `claude setup-token`'s own output convention is not
- [0008](docs/adr/0008-claude-code-adapter-agent-layer-and-attribution.md): the Claude Code Adapter's Agent layer runs as a non-root `agent` user (Claude Code refuses `--dangerously-skip-permissions` as root) and installs via the native installer (not npm); attribution is disabled by a baked `settings.json` rather than a CLI flag or the Preamble; `PreStartDeclaration` gains `ensureImage` rather than the plain `image: string` ADR 0005 sketched

## Development

```sh
bun test     # the suite; needs a running Docker engine
bun check    # typecheck
```

The tests drive real `git` and real Docker against throwaway repos and a throwaway `CRISOL_HOME`.
`crisol run` always defaults to the scripted stand-in Adapter unless `--adapter claude-code` is
passed explicitly, so the suite never calls a model or builds the real Agent layer image.

## License

[MIT](LICENSE)
