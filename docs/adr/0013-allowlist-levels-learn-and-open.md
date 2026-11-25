# The Allowlist's user and repo levels, `--network learn` and `--network open`

Ticket 07 makes the wall of crisol ADR 0012 editable. The spec (q8) asks for three merged levels:
built-in, user (`~/.crisol/network`) and repo (`.crisol/` `network = […]`). It also asks for
`crisol allow <host>` (user level), `crisol allow <host> --repo`, `--network learn` and
`--network open`.

## Both editable levels are one-host-per-line files, and `crisol allow` only appends

- **User**: `$CRISOL_HOME/network`.
- **Repo**: `.crisol/network` in the repo's working tree, committed beside the code.

Both files use one format, read by one parser: one hostname per line. Everything from `#` to the
end of a line is a comment (`api.stripe.com # payments`), and blank lines are skipped.
`crisol allow <host>` and `crisol allow <host> --repo` append one line, creating `.crisol/` and the
file when absent. They never rewrite a line already there, so a hand-written comment always
survives. A host already on that level, or built in, is not written.

### This deviates from the spec

The spec puts the repo level in `.crisol/config.toml` as `network = […]`. The first build of this
ticket did that, editing the key with the same hand-written single-line regex that reads `gates`
and `env` (crisol ADR 0006's placeholder). Review round 1 found that the edit:

- dropped single-quoted hosts and then rewrote them out of the file;
- read a `network = […]` line with a trailing `# comment` as no level at all, then refused to edit
  it with a false "must be on one line" error;
- ignored TOML table scope.

A research pass after that review surveyed Sandcastle, Claude Code (its native sandbox and its
reference devcontainer firewall), Codex CLI, Docker Sandboxes, `container-use`, the GitHub Copilot
coding agent and E2B. None of them regex-edits a shared config file to add a host: Claude Code
appends a rule to `settings.json`, Docker Sandboxes keeps its policy behind its own CLI, and Codex
and the devcontainer are edited by hand only. Where a config file is parsed at all, it is a real
parser, and Bun ships one (`Bun.TOML`), but its `stringify` drops comments and formatting, so a
parse-and-rewrite would still damage the rest of the user's file. A file Crisol only appends to
removes the whole class of bug rather than patching each case. The repo level then shares one
format and one parser with the user level, which this ticket introduces as well.

The same survey found no tool that keeps an allowlist as a bare one-host-per-line file. The closest
are JSON or TOML arrays and a YAML `allow:` list with one entry and comment per line. This choice
is untested ground, not a known pattern. `network` in `.crisol/config.toml` is no longer read at
all.

## Every host is validated where it enters, never escaped later

A host on either level ends up in two dangerous places:

- a tinyproxy filter regex (escaped, but a regex is still the wrong place to find out);
- the end-of-run advice, which prints `crisol allow` lines the user is told to paste.

So each level accepts only the plain-hostname shape crisol ADR 0012 defined for the advice
(`isPlainHostname`: letters, digits and hyphens, dot-separated, top-level label starting with a
letter), lowercased. That excludes a port, a wildcard (`*.example.com`) and an IP literal. An
allowlist Run whose user or repo level holds anything else fails in pre-flight, naming the file and
the host. `crisol allow` refuses such a host before writing.

The advice's "already on the Allowlist" check reads the merged list, not just the built-in one.

## No level, and no proposal, names a host inside the machine or network

A plain hostname can still point inside: `host.docker.internal` is the Docker host,
`metadata.google.internal` a cloud metadata service, `kubernetes.default.svc` a cluster's API. One
pasted `crisol allow` line, or one learn proposal accepted from a Run whose agent (or a Google
client library on a GCE dev VM) reached such a name, would commit that hole to every teammate's
Runs. So `isInternalHostname` refuses a name whose first label is `localhost`, or whose last label
is one of:

| Label | Why |
|---|---|
| `internal` | ICANN's private-use TLD; Docker's `host.docker.internal`/`gateway.docker.internal`, GCE's `metadata.google.internal`, AWS's `*.ec2.internal` |
| `local` | mDNS hosts on the LAN (RFC 6762), and Kubernetes' `cluster.local` |
| `localhost` | loopback (RFC 6761) |
| `localdomain` | the `/etc/hosts` loopback alias (`localhost.localdomain`) |
| `svc` | Kubernetes service names (`kubernetes.default.svc`) |
| `arpa` | reverse DNS, and `home.arpa` home networks (RFC 8375) |
| `lan`, `home`, `corp` | never delegated as public TLDs; routers and company DNS use them for LAN hosts |

Both levels refuse such a name when read, `crisol allow` refuses it before writing, the blocked
advice prints no allow line for it, and a learn Run never proposes it. The list is a denylist of
names, not of addresses. A public name that resolves to a private address is not caught. That is
DNS rebinding, and it is out of this ticket's reach.

## A repo's level widens the wall, and the agent can write it

`.crisol/network` is committed, so two things follow:

- Cloning a repo that carries one widens your wall for its Runs.
- The agent can append to it in its Clone and commit; once that branch is merged, every later Run
  in the repo reaches what it added.

Crisol makes both visible and blocks neither:

- At wall-up, an allowlist Run's log lists the merged Allowlist by level:
  `allowlist: 8 built-in; user: api.stripe.com; repo: sentry.io`.
- Fetch-back's commit scan, the same pass that flags an attribution trailer, adds a `warnings` entry
  when the branch's diff from base touches `.crisol/network`, naming each host it adds, quoted and
  unvalidated.

Blocking would mean reading the level from the base commit rather than the working tree, or
refusing a branch the human may well want. Neither is this ticket's call.

## Only an allowlist Run reads the levels

The levels exist for the filter, and only `allowlist` mode has one. `learn` and `open` read neither
level. A typo in `~/.crisol/network` therefore fails allowlist Runs (loudly, naming the line) but
never breaks the escape hatches in every repo.

## `--network learn` is a proxy with no filter, read from its own log

Learn keeps the whole wall: the `--internal` network, the proxy, and `Allow` scoped to the internal
subnet. Only the `Filter*` lines are dropped from `tinyproxy.conf`, and no filter file is mounted.
The Sandbox still has no direct route out, and every host it reaches goes through a proxy whose log
records it.

What tinyproxy 1.11.2 logs with no filter was probed live, on a real `--internal` network, with
`curl` from a container on it:

```
CONNECT   Nov 16 18:09:23.048 [6]: Request (file descriptor 4): CONNECT example.com:443 HTTP/1.1
CONNECT   Nov 16 18:09:23.127 [6]: Established connection to host "example.com" using file descriptor 5.
CONNECT   Nov 16 18:09:23.218 [6]: Request (file descriptor 4): GET http://example.com/ HTTP/1.1
CONNECT   Nov 16 18:09:23.308 [6]: Request (file descriptor 4): CONNECT does-not-exist-xyz123.invalid:443 HTTP/1.1
ERROR     Nov 16 18:09:23.509 [6]: opensock: Could not retrieve address info for does-not-exist-xyz123.invalid:443: Name does not resolve
```

The two line types carry different information:

- `Request` carries the target with its port.
- `Established connection` confirms a connection, but without the port.

Requests from separate connections interleave, so the two cannot be paired line by line. `reached`
therefore counts every `Request` whose host has at least one `Established connection`:

- A name that never resolved was not reached and is never proposed.
- A failed port on a host that did connect elsewhere counts as reached. That costs nothing, since a
  port is never proposed.
- Request targets are parsed exactly as refusals are (crisol ADR 0012): lowercased, with each
  scheme's own port folded in.

Both line patterns are anchored to tinyproxy's whole line prefix, timestamp included, in multiline
mode. That stops agent-chosen text in the middle of a `Request` line from matching as a connection.
It does not stop a bare `\r`: JavaScript's `m` flag treats `\r` as a line break, tinyproxy logs it
verbatim, and both reviewers forged an `Established` line that way live. This is ruled theoretical
and the parser is left alone. A forged entry can only add a host to the list printed for the user
to copy, and a learn Run can already reach any real host it likes.

`reached` is a new optional field of the Run result, present only on a `learn` Run, in the same
`{ host, port?, count }` shape as `blocked`.

### What a learn Run proposes, and how

At the end of a learn Run, the plain-text report prints one `crisol allow <host> --repo` line per
host worth adding, unioned across a Fan-out. A host is worth adding when it was reached, is a plain
hostname, is on its scheme's own port, and is neither built in nor on the repo level. The user
copies the lines they want. Nothing is asked and nothing is written. `--json` prints only the Run
result, whose `reached` lets a caller decide for itself.

The comparison is against built-in plus repo only, never the user level. Otherwise a host on the
developer's own `~/.crisol/network` would never be proposed, and the committed repo level would
stay incomplete for every teammate.

The first build asked `[y/N]` and wrote on yes. Review round 1 found two defects:

- Ctrl-C at the prompt was swallowed, because the Run's signal handlers were still installed.
- It hung forever on a non-TTY stdin that never closed.

The survey found no tool with an end-of-run batch prompt: Claude Code and Docker Sandboxes ask the
moment an unlisted host is first touched. Printing the lines removes both defects at the cause.

## `--network open` stands up no wall

`--network open` stands up no internal network, no proxy and no proxy env. The Sandbox goes back to
Docker's default network, as in ticket 01. Pre-flight skips the proxy image too, since an open Run
never runs it. The Run log says so (`network open: no wall`), and `network` is `"open"`. A Run that
ends before its Slot records its configured mode, not `"allowlist"`.

## What learn and open let the agent reach

Neither mode filters anything, on any port. In `open` the Sandbox itself sits on the default
bridge. In `learn` the proxy's own leg is on the default bridge and forwards wherever it is asked.
Either way the agent can reach:

- the Docker host (`host.docker.internal`), and services listening on it;
- the LAN;
- other containers on the default bridge;
- cloud metadata endpoints (`169.254.169.254`).

That is the meaning of "allows everything", and the reason both are explicit, named flags rather
than defaults.

## No Bun host was added to the built-in list

Crisol ADR 0012 left "Bun's hosts" and `raw.githubusercontent.com` for this ticket, to be added
only if a live check showed a real install needs them. That check ran with `oven/bun` (Bun 1.4.4)
and the skeleton image, through the learn proxy:

- `bun add zod esbuild sharp` (including platform-specific optional dependencies) made 77
  connections, all to `registry.npmjs.org`.
- `bunx cowsay` reached `registry.npmjs.org` only.
- `bun upgrade` reached `api.github.com`.
- The Bun install script (`curl https://bun.sh/install`, then the release zip) reached `bun.sh`,
  `github.com` and `release-assets.githubusercontent.com`.
- `raw.githubusercontent.com` answers when fetched directly, but no package install reached it.

So Bun's package operations need nothing beyond what is built in. The other hosts are for upgrading
Bun itself or for raw downloads, which belong to the image (ticket 12's Project layer), not to a
Run. `api.github.com` and `raw.githubusercontent.com` are also broad surfaces: any public repo's
content, and the whole GitHub API. They stay off the built-in list. A repo that needs one adds it
with `crisol allow --repo`, or finds it with `--network learn`.

## Follow-up

- `gates` and `env` are still read from `.crisol/config.toml` by the hand-written single-line
  parser. Moving them to `Bun.TOML.parse` (read-only, so the comment loss on write does not apply) is
  left for a later ticket.
- Ticket 17 (`crisol init`) must create an empty `.crisol/network`, not a `network` key in
  `config.toml` as the spec's q15 describes.

## Rejected

- **Repo level as `network = […]` in `.crisol/config.toml`, edited in place**: rejected above. A
  parse-and-rewrite through `Bun.TOML` would lose the file's comments and formatting.
- **An end-of-run y/N offer that writes on yes**: rejected above.
- **Learn as an allow-all filter (`.*`)**: a pattern that matches everything filters nothing.
  Dropping the filter does the same with one file fewer to write and mount.
- **Learn on Docker's default network, no proxy**: there would be nothing to read the hosts from.
- **Proposing built-in hosts, or anything but a plain hostname**: allowing a built-in host again
  changes nothing, and an agent-chosen string must never become a line the user is told to paste.
