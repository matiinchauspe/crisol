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
> Gates, converge, least-privilege credentials and the Allowlist network wall. `crisol run` still
> defaults to a scripted stand-in Adapter; the real Claude Code Adapter exists
> (`--adapter claude-code`) but isn't the default yet. See [Roadmap](#roadmap).

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
   see both errors. Ctrl+C, `kill` and closing the terminal stop a Run the same way: the
   container is removed and the branch still comes back with the commits made so far. Only
   `kill -9` skips this, and `crisol recover` brings that branch back.

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
crisol run ("<task>"... | --file <md>) [--context <md>]... [--prompt <name>] [--json | --detach] [--base <ref>] [--name <branch>] [--gate <cmd>]... [--max-iterations <n>] [--timeout <minutes>] [--network <allowlist|learn|open>] [--adapter <fake|claude-code>]
crisol allow <host> [--repo]
crisol status
crisol logs <run>
crisol auth
crisol recover
crisol gc [--include-failed]
```

| Flag | Default | What it does |
|---|---|---|
| `--file <md>` | none | The file's content is the Task, in place of a phrase. One file, and not beside a phrase. |
| `--context <md>` | none | A reference file the agent gets after the Task, in its own section, marked as reference rather than work. Repeatable. |
| `--prompt <name>` | none | Wraps the Task in a template. See [The Task the agent gets](#the-task-the-agent-gets). |
| `--base <ref>` | your current `HEAD` | Branch, tag or sha to cut the Run's branch from. It must be reachable from a local branch, a tag or `HEAD`, because that is all the Clone receives. To use `origin/main`, check it out or fast-forward a local branch onto it first. |
| `--name <branch>` | `crisol/<id>` | The branch name the Run leaves in your repo. Refused before anything happens if it clashes with an existing branch, a tag, or a branch path (for example `feat` vs `feat/x`). Only with a single Task. |
| `--gate <cmd>` | none | A command whose exit code decides whether the work is right. Repeatable. Any `--gate` replaces your repo's own `.crisol/config.toml` Gates entirely — it never merges with them. |
| `--max-iterations <n>` | `5` | Overrides how many Gate-fail-then-resume attempts this Run gets before `not-converged`. Must be a positive integer. |
| `--timeout <minutes>` | `60` | Overrides the wall-clock ceiling for this Run, in minutes. Must be a positive integer. |
| `--network <allowlist\|learn\|open>` | `allowlist` | `learn` lets the Run reach any host and records which; `open` drops the wall. See [Network](#network). |
| `--adapter <fake\|claude-code>` | `fake` | Which Adapter runs the Task. `fake` is the suite's own scripted stand-in; `claude-code` runs the real Claude Code Adapter (`crisol auth` first — see [Credentials](#credentials)). |
| `--json` | off | Print the Run result as JSON instead of one line — one JSON line per Run when there are several Tasks. |
| `--detach` | off | Return at once with the run id and let the Run finish in the background. One Task only, and not with `--json`. See [Detach, status and logs](#detach-status-and-logs). |

A repo can declare its own Gates once, in `.crisol/config.toml`:

```toml
gates = ["bun test", "bun run typecheck"]
```

### The Task the agent gets

Crisol never reads a tracker: the Task is the text you give it. The agent receives, in order:

1. **The Preamble**: it is in a sandbox, the Gates this Run will check (by command), commit and do
   not push, and say so when the network blocks something rather than work around it. A
   `--detach`ed Run names the Gates its own background process re-resolves from
   `.crisol/config.toml`, not necessarily the ones the launching terminal saw — they can drift if
   that file changes in between (see ADR 0014's "Not addressed").
2. **The Task**, inside `<task>` tags, after `--prompt`'s template is applied.
3. **Each `--context` file**, inside its own `<reference file="…">` tags.

A template is a Markdown file whose only variable is `{{task}}`. Crisol looks for `--prompt <name>`
in three places, and the first found wins:

1. `.crisol/prompts/<name>.md` in your repo;
2. `~/.crisol/prompts/<name>.md`;
3. Crisol's built-in templates (`fix-bug`).

A template that uses any other `{{…}}`, or lacks `{{task}}`, fails the Run before anything happens.
A name starts with a letter or digit, followed by letters, digits, `-` and `_`.

`--file`, `--context` and templates must be UTF-8 text: a file with a NUL byte or invalid UTF-8 is
refused before anything happens, as is an empty one. Every file is read once, by the `crisol run`
you launched, even with `--detach`, so a temporary file can go as soon as the command returns.
The prompt the agent received is kept in `runs/<id>/prompt`.

```bash
crisol run --file tickets/42.md --context docs/spec.md --prompt fix-bug
```

### Several Tasks at once

```
crisol run "fix the login bug" "add a health check" "bump the README badges"
```

Each Task becomes its own independent Run: its own Clone, its own Sandbox, its own branch, all
cut from the same base commit. Crisol never chains or merges them — what to do with the branches
is up to you. With `--json`, each Run result is printed on its own line, in the order the Tasks
were given; a Run that fails prints its error on stderr, prefixed with its Task, and the command
exits non-zero without hiding the others.

At most `max_parallel` Runs execute at once (3 by default), across every `crisol run` on the
machine — including ones started from different terminals. A Run must hold one of
`~/.crisol/slots/<n>.lock` to execute; with none free it waits, printing
`Waiting for a free Slot`, and never fails for lack of one. The lock is an OS file lock, so a
Run that dies — even by `kill -9` — gives its Slot back at once. A waiting Run already has its run
id, so `crisol status` shows it as `queued`. Ctrl+C on a waiting Run stops it before it makes its
Clone, so it cuts no branch. Its log and Run result are kept, like any Run's: `not-converged`,
`reason: "interrupted: SIGINT"`.

```toml
# ~/.crisol/config
max_parallel = 2
```

### Provider failures and capacity

A rate limit, an exhausted quota or a failed authentication from the agent's own provider is not a
red Gate: the Run stops at once, without spending an iteration on it, `not-converged` with
`reason: "provider: <category>"` (for example `provider: rate limit`). With several Tasks at once,
it also keeps a Run still waiting for a Slot from starting, rather than let it begin only to hit
the same outage — that Run ends the same way a Ctrl+C-while-queued one does, with
`reason: "interrupted: provider: <category>"`.

Each Sandbox is capped at 2 CPUs and 4 GB by default, overridable in `~/.crisol/config`:

```toml
# ~/.crisol/config
cpus = 4
memory = 8g
```

`memory` takes Docker's own size syntax (a byte count, or one with a `b`/`k`/`m`/`g` suffix). The
cap applies to the Sandbox only — never the Allowlist proxy or a Service container. An unreachable
Docker engine fails with a plain message naming how to start it (see
[Requirements](#requirements)), never a raw socket error.

### Detach, status and logs

```console
$ crisol run "fix the login bug" --detach
9f496a56
Run 9f496a56 detached as pid 41872. `crisol status` shows it; `crisol logs 9f496a56` prints its log; `kill 41872` stops it.
$ crisol status
9f496a56  running        crisol/9f496a56  pid 41872
3c1d07e2  queued         crisol/3c1d07e2  pid 41901
51b8aa90  verified       crisol/51b8aa90
$ crisol logs 9f496a56
```

`--detach` checks everything a Run checks before it starts. A bad base, name or Gate still fails
right there, and leaves nothing behind. Then it reserves the Run and hands it to a background
process of its own. Once that process holds the Run, `--detach` prints the id and the process's pid
and returns. From then on, the Run continues in that background process. Crisol has no daemon: that process owns the Run,
just as `crisol run` does in the foreground. Closing the terminal does not stop it. To stop it,
`kill` the pid that `--detach` and `crisol status` show. It then stops like a Run you Ctrl+C: a
running Run's container is removed and its branch comes back, and a queued Run ends without one. The Run result goes to `result.json`. Anything the Run would have printed,
including warnings, goes to its log.

`crisol status` lists every Run under `~/.crisol`, oldest first:

| State | Meaning |
|---|---|
| `queued` | Reserved, waiting for a free Slot. Shown with the pid of the process that owns it. |
| `running` | Holds a Slot and has its Clone. Shown with its pid. |
| `verified` / `unverified` / `not-converged` | Finished; the Run result's Status, followed by its `reason` when there is one. |
| `dead` | Died without writing a Run result, for example after `kill -9`. If it had made its Clone, `crisol recover` brings back its branch. A Run that died while queued never made one, so there is nothing to bring back. |

`crisol logs <run>` prints that Run's log. An id that is not a Run fails with a plain message.

### Network

Every Sandbox sits on its own Docker `--internal` network — no route out at all except through a
proxy that allows HTTPS `CONNECT` on port 443 (and plain HTTP on port 80) to an Allowlist, with no
TLS interception and no certificate anywhere in the image. The built-in Allowlist covers the Anthropic API and the package
registries a Run needs to install dependencies (`registry.npmjs.org`, `github.com`,
`codeload.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
`pypi.org`, `files.pythonhosted.org`).
A host it doesn't name is refused, and every refusal is counted:

```json
"blocked": [{ "host": "api.stripe.com", "count": 3 }]
```

The end-of-run report names each one and the line that would allow it:

```
Blocked: api.stripe.com (3 attempts). Allow it for every repo, or for this repo only, with:
  crisol allow api.stripe.com
  crisol allow api.stripe.com --repo
```

Only a plain hostname gets those lines. An IP literal, or a host carrying anything but letters,
digits, dots and hyphens, is printed quoted with nothing to paste. A host already on the
Allowlist that was refused for its form (a bare `CONNECT github.com`, say) gets no line either.

An allowlisted host reached on any other port is refused too, and its entry carries the port
(`{ "host": "github.com", "port": 22, "count": 1 }`) — no `crisol allow` line opens a port.

#### Widening the Allowlist

The Allowlist a Run gets is three levels merged:

| Level | Where | Edited by |
|---|---|---|
| built-in | inside Crisol | each release |
| user | `~/.crisol/network` | `crisol allow <host>` |
| repo | `.crisol/network`, committed | `crisol allow <host> --repo` |

Both files hold one host per line; everything after a `#` is a comment:

```
# payments
api.stripe.com   # checkout
sentry.io
```

`crisol allow` appends one line, creating the file if needed, and never rewrites what is already
there. A host added at either level is reachable from the next Run on. Every level takes plain
public hostnames only — no port, no wildcard, no IP address, and no name that points inside your
machine or network (`host.docker.internal`, `metadata.google.internal`, anything under `.internal`,
`.local`, `.localhost`, `.localdomain`, `.svc`, `.arpa`, `.lan`, `.home` or `.corp`). An allowlist
Run whose user or repo level holds anything else fails before it starts, naming the file and the
host. `--network learn` and `--network open` read neither level, so a bad line never breaks them.

A repo's `.crisol/network` widens your wall: cloning a repo that carries one lets its Runs reach
those hosts. The agent can write it too, by committing to it, and once you merge that branch every
later Run reaches what it added. Crisol shows both and blocks neither. The Run log lists every host
the user or repo level brought (`allowlist: 8 built-in; user: …; repo: …`). A branch whose changes
touch `.crisol/network` carries a `warnings` entry naming the hosts it adds. Read that file in a
review the way you would read a dependency bump.

`--network learn` lets a Run reach any host through the proxy, and records every host the proxy
connected to in the Run result's `reached`. The Sandbox stays on its `--internal` network, so only
HTTP and HTTPS through the proxy get out. Git over ssh, `git://`, a remote database, or any tool that
ignores the proxy variables still fails, and is never in `reached`. At the end, the plain-text report prints a
`crisol allow <host> --repo` line for each reached host that is neither built in nor on the repo
level — copy the ones the repo needs. It asks nothing and writes nothing. Hosts on your own user
level are proposed too, so teammates get them through the repo level. With `--json`, only the Run
result is printed; `reached` is in it.

`--network open` stands up no wall at all: the Sandbox sits on Docker's default network and
`network` reads `"open"`.

> [!WARNING]
> `--network learn` (through its proxy) and `--network open` filter nothing, on any port. The agent can reach the Docker
> host (`host.docker.internal`) and what listens on it, your LAN, other containers on the default
> bridge, and cloud metadata endpoints (`169.254.169.254`). Use them on code and data you would
> let leave your machine.

Package installs with Bun reach only `registry.npmjs.org`, already built in. Upgrading Bun itself
reaches `api.github.com` (`bun upgrade`) or `bun.sh` (the install script), and a raw file download
reaches `raw.githubusercontent.com`; those stay off the built-in list — a Run that needs one adds
it with `crisol allow` or finds it with `--network learn`
([ADR 0013](docs/adr/0013-allowlist-levels-learn-and-open.md)).

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

### Services

A repo whose e2e tests need something like Postgres declares it once, in `.crisol/services.yml`,
restricted to four keys per service:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: crisol
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 1s
      timeout: 2s
      retries: 30
```

Any other key — `ports`, `volumes`, `depends_on`, anything compose otherwise allows — fails the Run
before anything happens, naming it. Each declared Service gets its own container, one per Run,
reachable from inside the Sandbox by its name alone (`db:5432`) — never by its real container name,
which carries the run id so two parallel Runs' same-named Services never collide. It is destroyed
with the Run.

The agent launches only once every Service that declares a `healthcheck` reports healthy; one that
never does fails the Run before any iteration is spent, with `iterations: 0`. `environment` takes a
mapping or compose's `KEY=VALUE` list form; `command` takes a list (exec form) or a single string
(run through the image's shell, like compose's shell form); `healthcheck.test` is `["CMD", …]`,
`["CMD-SHELL", "<cmd>"]`, or `["NONE"]`, with optional `interval`, `timeout`, `retries` and
`start_period` passed straight to Docker's own healthcheck.

A Service normally joins the same network the Allowlist wall already put the Sandbox on.
`--network open` stands up no wall, so a Run whose repo declares one gets a network just for that,
and the Sandbox joins both it and its usual internet-carrying default network.

### Image and dependencies

The Sandbox runs on two image layers, both built locally — never from a registry. The **Project
layer** is your repo's own toolchain: commit a `.crisol/Dockerfile` and every Run builds and
caches it by its own content, so editing it is the only way to change what's inside. No
`.crisol/Dockerfile` falls back to Crisol's own default — Alpine with `git`, `bash`, `curl`,
Node, Bun, Python, `gh` and `rg`. The **Agent layer** is always built by Crisol on top, from the
Adapter's own definition (for `--adapter claude-code`: the agent CLI pinned to your host's own
version, see [Credentials](#credentials)); cached by a hash of the Project layer image, the
agent version and the Tenaza version, so a change to any of the three rebuilds it on the next
Run.

Dependencies are installed fresh into each Run's own Clone — never shared, never baked into
either image. The package manager is picked from whichever lockfile is committed:

| Lockfile | Installs with |
|---|---|
| `bun.lock` | `bun install` |
| `pnpm-lock.yaml` | `pnpm install` |
| `package-lock.json` | `npm ci` |
| `yarn.lock` | `yarn install` |

A repo with none of the four skips the install entirely. Whichever manager runs, its own cache
(the pnpm store, bun's cache, npm's cache, yarn's cache) lands in one Docker volume shared across
every Run, so a later Run's install reuses what an earlier one already downloaded — only the
installed `node_modules` itself is never shared. `pnpm`/`yarn` are not part of Crisol's own
default Project layer; a repo whose lockfile needs one supplies it in its own `.crisol/Dockerfile`.
A failed install fails the Run before the agent ever launches, with `iterations: 0`.

### Recover

```
crisol recover
```

Brings back the branch of every Run that died without its Fetch-back, for example after
`kill -9` or a crash. A Run holds its own lock while it is alive, so recover never touches a live
Run. For a dead Run, it first removes the Run's container, so the agent cannot keep writing to the
Clone. Then it fetches the branch into the repo the Run came from, at the Clone's last commit.
Fetch-back only fast-forwards: a branch you have since moved is reported and left alone, and
recover never deletes a branch. It prints one line per Run it acted on or left alone, or
`Nothing to recover.`

### Garbage collection

```
crisol gc [--include-failed]
```

Disk is freed only on request. `crisol gc` collects a Run's `repo/` (its Clone) and its Allowlist
`network/` dir once ALL of these hold: Fetch-back completed, 7 days passed since the Run finished,
and the branch is still in the host repo at the same commit the Clone cut it from — a branch moved,
rebased or deleted since is refused, naming why. `log`, `result.json`, `lock`, `pid` and `prompt`
are never touched, and `gc` never deletes a branch, whatever you confirm. `--include-failed` adds
`not-converged` Runs to what counts, on top of every other check above — it does not waive any of
them. A Run still missing its Fetch-back is never collected either way; run `crisol recover` first.

```console
$ crisol gc
2 Run(s) ready to collect, freeing ~3.1 GB:
  9f496a56  crisol/9f496a56  ~1.6 GB
  3c1d07e2  crisol/3c1d07e2  ~1.5 GB
Delete these Run dirs? [y/N] y
Run 9f496a56: collected, freed ~1.6 GB.
Run 3c1d07e2: collected, freed ~1.5 GB.
```

Anything but `y`/`yes` — including piping nothing in at all — declines and deletes nothing.
`crisol run` warns at the end when `~/.crisol/runs` as a whole passes 20 GB (roughly five Runs at
this spec's own high estimate), overridable with `gc_warn_bytes` in `~/.crisol/config`. That check
is a cheap running total, not a fresh measurement; `crisol gc` is what resyncs it exactly, every
time it runs, whether or not it collects anything — so a warning that looks wrong clears on the
next `crisol gc`.

```toml
# ~/.crisol/config
gc_warn_bytes = 10000000000
```

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
  "network": "allowlist",
  "blocked": [],
  "warnings": [],
  "fetchBack": true,
  "finishedAt": 1732104000000
}
```

`status` is `verified` once every declared Gate is green, `not-converged` (with
`reason: "ceiling"`) if it never gets there within the ceiling (5 iterations or 60 minutes by
default — see [The ceiling](#the-ceiling)), and `unverified` when no Gate is declared anywhere —
the CLI's `--gate`, else the repo's own `.crisol/config.toml`.
A red Gate resumes the same agent session with its failing command and output; `iterations`
counts how many attempts that took. A Run stopped by a signal or an error is `not-converged` too,
with `reason` set to `interrupted: SIGINT` (or the signal it got) or `error: <message>`. A provider
failure (a rate limit, an exhausted quota, a failed authentication) is `not-converged` with
`reason: "provider: <category>"`, without spending an iteration on it — see
[Provider failures and capacity](#provider-failures-and-capacity). The CLI reports any of these as
an error (exit code 1, the message on stderr), and `--json` still prints the Run result on stdout,
same as `result.json` holds. `fetchBack` says whether the
branch reached your repo. When it is `false` and the Run made its Clone, `crisol recover` can still
bring the branch back. A Run stopped while queued never cut one. A container
Crisol could not remove is named in `warnings`. `network` is `allowlist` by default now that the
wall exists ([ADR 0003](docs/adr/0003-run-result-reports-network-open-until-the-wall-exists.md),
[ADR 0012](docs/adr/0012-network-wall-is-tinyproxy-on-an-internal-network-with-the-allowlist-bind-mounted.md)),
and `learn` or `open` with `--network`; a `learn` Run adds `reached`. See [Network](#network) for
`blocked` and `reached`. `finishedAt` is when this result was written, in epoch milliseconds — what
[`crisol gc`](#garbage-collection)'s 7-day rule reads, never a dir's own birthtime.

### Where things live

```
~/.crisol/                 # override with CRISOL_HOME
├── config                 # optional: max_parallel / max_iterations / timeout_minutes / cpus / memory / gc_warn_bytes overrides
├── network                # optional: the user level of the Allowlist, one host per line
├── prompts/<name>.md      # optional: your own `--prompt` templates
├── slots/<n>.lock         # one per Slot; a Run holds one while it executes
├── runs-size              # a running total of `repo/` + `network/` bytes; `crisol run` reads only this, never `runs/`
└── runs/<id>/             # made when the Run is reserved, before it waits for a Slot
    ├── repo/              # the Run's Clone, made once the Run holds a Slot (status: running)
    ├── lock               # held while the Run is alive; how `status` and `recover` tell live from dead
    ├── pid                # the process that owns the Run; `status` shows it while that process holds the Run
    ├── prompt             # the Preamble, Task and Context the agent received
    ├── log                # timestamped log of every stage; a detached Run's output too
    └── result.json        # the Run result, written on every exit
```

## Roadmap

v1 is built as 18 tracer-bullet tickets. Each one leaves Crisol working end to end.

| # | Ticket | |
|---|---|---|
| 01 | Walking skeleton | ✅ |
| 02 | Gates and converge | ✅ |
| 03 | Slots and fan-out | ✅ |
| 04 | Fetch-back on every exit, and recover | ✅ |
| 05 | Detach, status, logs | ✅ |
| 06 | Network wall | ✅ |
| 07 | Editable Allowlist, learn and open | ✅ |
| 08 | Credentials | ✅ |
| 09 | Commits | |
| 10 | Text input | ✅ |
| 11 | Services | ✅ |
| 12 | Two-layer image and dependencies | ✅ |
| 13 | Provider failure and capacity | ✅ |
| 14 | Claude Code Adapter | ✅ |
| 15 | Tenaza inside | |
| 16 | `crisol gc` | ✅ |
| 17 | `crisol init` | |
| 18 | Release 0.1.0 | |

## Vocabulary and decisions

Crisol uses a small, strict vocabulary: **Run**, **Task**, **Sandbox**, **Clone**, **Fetch-back**,
**Gate**, **Adapter**, **Slot**, **Run lock**, **Fan-out**, **Detached Run**, **Secret**, **SecretStore**,
**Service**, **Preamble**, **Context**, **Template**. Each term is defined in
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
- [0009](docs/adr/0009-slots-poll-a-non-blocking-flock.md): a Slot is taken by polling a non-blocking `flock` rather than blocking on it, before the Run reserves anything; a fan-out prints one Run result per line (amended by 0011: a Run is now reserved before it waits for a Slot)
- [0010](docs/adr/0010-a-run-lock-proves-liveness-and-signals-never-reach-crisols-children.md): each Run holds its own lock, which is how `crisol recover` tells live from dead; SIGINT, SIGTERM and SIGHUP stop a Run the same way once it holds its Slot (amended by 0011); git and docker children run in their own session; `result.json` is written on every exit and records `fetchBack`
- [0011](docs/adr/0011-a-run-is-reserved-before-its-slot-and-a-detached-run-inherits-its-lock.md): a Run is reserved before it waits for a Slot, so `status` can show it queued (reversing part of 0009, amending 0010); a Run stopped while queued keeps its log and Run result; `status` reads state from the run dir alone; a detached Run's process inherits its Run lock as fd 3, so the lock is never free in between
- [0012](docs/adr/0012-network-wall-is-tinyproxy-on-an-internal-network-with-the-allowlist-bind-mounted.md): the network wall is tinyproxy on a per-Run `--internal` network, the Allowlist bind-mounted in rather than baked into the image; blocked hosts are counted by parsing tinyproxy's own log; the Sandbox's env carries both casings of `HTTP(S)_PROXY`/`NO_PROXY` (supersedes 0003)
- [0013](docs/adr/0013-allowlist-levels-learn-and-open.md): the user level is `~/.crisol/network` and the repo level `.crisol/network` (not `network = […]` in `config.toml`, as the spec had it), both one host per line, plain public hostnames only (no `.internal`, `.local`, `.svc` and the like), appended to by `crisol allow`; a branch that touches `.crisol/network` carries a warning; only an allowlist Run reads them; `--network learn` is a filterless proxy whose log yields `reached`, and it prints `crisol allow --repo` lines instead of asking; `--network open` stands up no wall; no Bun host was added to the built-in list
- [0014](docs/adr/0014-the-prompt-travels-over-stdin-and-is-resolved-once.md): the agent receives one prompt (Preamble, Task, Context) over stdin, never argv; every input file is read once, in the process the user launched, and the prompt is saved to `runs/<id>/prompt`, which a detached Run's process reads; templates are looked up repo, then user, then built-in
- [0015](docs/adr/0015-services-share-the-runs-network-and-health-gate-on-docker-run---health-cmd.md): `.crisol/services.yml` is read by a hand-rolled YAML subset parser, not a dependency; a Service joins the wall's network when one exists, else a bare network of its own (reusing `crisol-net-<id>`, so `crisol recover` already sweeps it for free); health-gating runs on `docker run --health-cmd`, polled through `docker inspect`; open mode plus a Service joins the Sandbox to a second network after creation, since Docker refuses to mix the default bridge with a user-defined network at creation time
- [0016](docs/adr/0016-two-layer-image-tenaza-absent-cache-key-and-dependency-install.md): the Project layer is read from the host working tree and cached by its own content hash, with Crisol's own default gaining the spec's full toolchain (git, Node, Bun, Python, `gh`, `rg`); the Agent layer's cache key becomes a real hash of (Project layer image, agent version, Tenaza version), the Tenaza component a fixed placeholder until ticket 15 exists; dependency install runs as Crisol's own infra step before the agent launches, the package manager detected from the Clone's own lockfile, its cache in one shared Docker volume fixed up for whichever user owns the Sandbox via `docker exec -u root`
- [0017](docs/adr/0017-provider-failure-is-adapter-owned-and-resolves-like-a-ceiling.md): a provider failure is a new `ProviderFailureError` only the Adapter can throw (the real Claude Code Adapter's exact wire format is unverified and left generic); it resolves `run()` like the ceiling, rather than rejecting; `--json` now prints the Run result on every exit that computed one, by attaching it to the thrown error rather than changing which exits reject (amends ADR 0010); a provider failure aborts a sibling Run still waiting for its Slot via a new `onProviderFailure` callback; `--cpus`/`--memory` cap the Sandbox container alone, default 2 CPUs / 4 GB, overridable in `~/.crisol/config`
- [0018](docs/adr/0018-gc-ages-runs-by-a-stored-finishedat-and-verifies-the-host-branch-live.md): `RunResult` gains `finishedAt` (a dir's own birthtime cannot be back-dated, verified live) for `crisol gc`'s 7-day rule; "the recorded commit" is read live from the Clone's own branch tip, never persisted; `--include-failed` lifts only the status restriction, never the age or branch-verification checks; the confirmation prompt is one `y`/`yes` comparison with no `--yes` escape hatch (ADR 0013's lesson); `gc` deletes exactly `repo/` and the per-Run `network/` dir; the size-warning threshold is a plain, overridable byte count (`gc_warn_bytes`)

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
