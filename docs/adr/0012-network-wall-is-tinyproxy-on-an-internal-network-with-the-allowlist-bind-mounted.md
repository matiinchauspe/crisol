# The network wall is tinyproxy on a `--internal` network, the Allowlist bind-mounted in

Ticket 06 builds the Allowlist wall (spec "Network" q8): every Run's Sandbox sits on its own
Docker `--internal` network whose only way out is a proxy allowing HTTPS `CONNECT` (and HTTP) to
allowlisted hosts, no TLS interception. This supersedes crisol ADR 0003 — `network` now reports
`"allowlist"`, not `"open"`, since a real wall exists to report on. `"learn"` and `"open"`, and the
user/repo Allowlist levels behind `crisol allow`, are ticket 07's.

## The proxy is tinyproxy 1.11.2, a blind CONNECT tunnel

A prior, stopped attempt at this ticket had already picked tinyproxy — verified here, not just
inherited: a real Alpine 3.20 container reports `tinyproxy 1.11.2`, and `FilterType ere` /
`FilterDefaultDeny Yes` is a real, working combination against it (checked with a live proxy, a
real internal network, and `curl`, not read off documentation alone). tinyproxy never decrypts a
`CONNECT` tunnel — it relays raw bytes — so "no TLS interception, no certificates in the image" is
true by construction, not an extra guarantee Crisol has to build.

## The filter matches whole URLs, so every pattern pins a port

Matching the host alone (tinyproxy's default) left a hole a reviewer confirmed live: tinyproxy's
`ConnectPort` only governs `CONNECT`, so a plain `GET http://github.com:22/` was forwarded to port
22 of an allowlisted host — any port of any allowlisted host was reachable over plain HTTP.

`FilterURLs On` closes it. tinyproxy then matches a `CONNECT` against `host:port` and a plain HTTP
request against its whole URL, so each allowlisted host gets two patterns:

```
^github\.com:443$
^http://github\.com(:80)?/
```

The trailing `/` matters: `http://github.com:80@evil.example.org/` routes to `evil.example.org`,
and without the `/` it would match as `github.com`. `ConnectPort` is dropped — the filter already
pins every port, and tinyproxy's `ConnectPort` refusal (`Refused CONNECT method on port 22`) logs
the port without the host, which `blocked` could not attribute. `CONNECT` to port 80 is refused
now too; nothing on the built-in list needs it.

Probed against a real 1.11.2 proxy on a real `--internal` network, with `curl` from a container on
it. Before: for `http://github.com:22/` tinyproxy logged `opening connection to github.com:22` and
answered with an empty reply or a 503 — port 22's SSH banner, not a refusal. After, three runs
on fresh containers: `http://github.com:22/`, `http://github.com:443/`,
`http://example.com:80@evil.example.org/` and `CONNECT github.com:22` all refused (403), while
`http://` and `https://` to an allowlisted host, any letter case, pass. Matching is
case-insensitive by default. A missing filter file stops tinyproxy at start (exit 65), so the
wall cannot come up open. One trap met while probing: rewriting a bind-mounted filter in place
and restarting a container under the same name gave stale, inconsistent answers; a Run never
does either, since every Run writes fresh files under its own directory and names its own proxy.

## Each Run gets its own network and proxy container, named and labelled like the Sandbox

`crisol-net-<id>` (`docker network create --internal`) and `crisol-proxy-<id>`, both carrying
`crisol.run=<id>` — the same label the Sandbox already carries (spec q1: no writable state shared
between Runs extends to the network too). Sharing the label means `crisol recover`'s existing
container sweep (`removeRunSandboxes`, by label) already covers the proxy for free; only the
network — not a container — needed its own removal, `removeNetworkByRunId`, added to
`recoverDeadRun` alongside it.

The proxy starts on the default bridge first (its own egress to the real internet — it is never
`--internal` itself) and is then `docker network connect`ed to the Run's internal network as a
second interface, so the Sandbox can resolve it by container name over embedded DNS. Verified live:
a container on an internal-only network can still be reached by `docker exec` from the host (exec
goes through the daemon, not the container's own network), and a container with two network legs
resolves fine by name on either one.

## The Allowlist is two bind-mounted files, never baked into the proxy's image

`ensureProxyImage` builds and caches a BARE `tinyproxy` image (no `Filter`/`tinyproxy.conf` inside
it) — `/etc/tinyproxy/tinyproxy.conf` and `/etc/tinyproxy/filter` are generated per Run and
bind-mounted read-only at `docker run` time, the same mechanism `MountSpec` already gives an
Adapter's own pre-start mounts. Baking the allowlist into the image instead would mean a different
image — and a fresh, uncached build — for every repo's own `.crisol/` `network = […]` list once
ticket 07 lands; the bind-mount keeps one proxy image for every Run regardless of what it allows.

`Filter`'s patterns are the built-in list's hostnames, anchored and escaped exactly
(`^registry\.npmjs\.org:443$`), never a subdomain wildcard — least privilege, the same boundary
Credentials (crisol ADR 0007) already draws for secrets.

## `Allow` is scoped to the internal network's own subnet, read back after creating it

`docker network inspect <name> --format '{{(index .IPAM.Config 0).Subnet}}'` (confirmed against a
real network) gives the CIDR tinyproxy's `Allow` is generated with — not `0.0.0.0/0`. The proxy's
OTHER leg (the default bridge, for its own egress) would otherwise let any unrelated container on
that bridge use this Run's proxy as a relay to the same allowlisted hosts. A lookup that fails
(`undefined`) fails the Run before the proxy starts: `startNetworkWall` throws, after removing the
network it had created, rather than write an `Allow 0.0.0.0/0` it could not scope.

## Blocked attempts are counted by parsing tinyproxy's own log, not a second mechanism

With `FilterURLs On`, tinyproxy logs a refused request as:

```
NOTICE    <timestamp> [<pid>]: Proxying refused on filtered url "github.com:22"
NOTICE    <timestamp> [<pid>]: Proxying refused on filtered url "http://evil.example.org/"
```

(captured from a real 1.11.2 container): `host:port` for a `CONNECT`, the whole URL for plain
HTTP. The host is read as tinyproxy routes it, past any `user@`, and lowercased. A refusal on the
scheme's own port (443 for `CONNECT`, 80 for HTTP) counts under the bare host; any other port is a
separate entry carrying `port`, an added optional field, and the end-of-run report gives it no
`crisol allow` line, since the Allowlist names hosts and never opens a port.

The host in a refusal is whatever the agent sent, and `URL` accepts `$ ( ) \` ;` in it: a
reviewer's `CONNECT a$(id)b.com:443` came out as the line `crisol allow a$(id)b.com`, which the user
is told to paste. So only a plain hostname — letters, digits, hyphens, dot-separated, with a
top-level label starting with a letter — gets an allow line. An IP literal (`1.2.3.4`, `[::1]`)
or any other host is printed JSON-quoted with no command. A host already on the Allowlist gets no
line either: it was refused for its form (a portless `CONNECT github.com`, or
`http://example.com@github.com:80/` folded into `github.com`), and allowing it again changes
nothing. `crisol allow` itself is ticket 07's, so the advice says it is not built yet. `readBlocked`
reads the proxy's `docker logs` BEFORE tearing it down — there is nothing left to read after — and
`parseBlockedHosts` counts occurrences per host with one regex, no second logging path and no
extra flag on tinyproxy. `blocked` keeps the `{ host, count }` shape `run.ts` already declared,
plus that optional `port`.

## `phase` is deferred

The ticket and the spec ask for each blocked attempt as `(host, count, phase)`. `phase` is not
built. The agent and its Gates share one Sandbox and one proxy for the whole Run, and the proxy's
log carries no marker of which of them sent a request, so a `phase` today would be a guess. The
phase worth separating — dependency installs, before the agent starts — does not exist until ticket
12; `phase` lands with it as an added field. The stable JSON contract only ever adds fields, and its
own example shows none.

## The Sandbox's env carries both casings of the proxy variables

`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` AND `http_proxy`/`https_proxy`/`no_proxy`. Verified against a
real `curl`: for the literal `http` scheme, curl reads ONLY the lowercase `http_proxy` — a
deliberate choice since the httpoxy class of vulnerabilities (an attacker-controlled `Proxy:`
header becoming `HTTP_PROXY` for a CGI-style process) — while `HTTPS_PROXY` (either case) and most
other tools (`npm`, `pip`, `git`) read the uppercase names. Setting only one casing would silently
drop plain-HTTP traffic (`curl`) or HTTPS traffic (several package managers) around the wall rather
than through it; both cost nothing extra to set as plain, non-secret env.

## `NO_PROXY` is set to `localhost,127.0.0.1`

Nothing else is reachable from inside the Sandbox yet (`.crisol/services.yml` is ticket 11's) — the
value only keeps a tool's own loopback calls from trying to tunnel through a proxy that was never
meant to carry them.

## The skeleton image gains `curl`, and its tag is bumped

Ticket 01's `SKELETON_DOCKERFILE` (crisol ADR 0002's placeholder) had `git` and `bash` only — no
tool to probe the network from inside a Sandbox at all. `curl` is added for exactly that (this
ticket's own fake-Adapter scripts), and `SKELETON_IMAGE_TAG` moves from `0.1.0-skeleton` to
`0.1.1-skeleton` alongside it: `ensureImageFromDockerfile` caches strictly by TAG, never by content
hash (crisol ADR 0002 names the real content-hash cache as ticket 12's), so a machine that had
already built the old, curl-less image under the old tag would otherwise keep serving it forever.

## One host was added after a live check; the rest wait for ticket 07

`release-assets.githubusercontent.com` is on the built-in list: a GitHub release download
(`github.com/<owner>/<repo>/releases/download/...`) answers 302 to it, checked live, and the same
download through the wall returns 200 after a `CONNECT` to that host. Every other candidate —
Bun's registry hosts, `raw.githubusercontent.com` — stays off until it is checked the same way:
guessing would put unverified hosts inside the wall. Ticket 07 makes the Allowlist editable and adds
`--network learn`, which records the hosts a real install reaches.

## Rejected

- **A TLS-intercepting proxy (mitmproxy, squid with SSL-bump)** — the spec is explicit: "no TLS
  interception, no certificates in the image." A blind CONNECT tunnel gives host-level filtering
  (which the ticket's own acceptance boxes only ever ask for) with no certificate to manage, trust,
  or leak, at the cost of never being able to filter by URL path — not asked for here.
- **One shared network and proxy across every Run** — the spec's Boundary (q1) and "Workspace"
  sections already commit Crisol to zero shared writable state between Runs; a shared network
  would make one Run's blocked-host count (and, once ticket 07 lands, one repo's wider allowlist)
  visible to every other Run sharing it.
- **Baking the built-in Allowlist into the proxy's image** — rejected above; bind-mounting is the
  one choice that keeps ticket 07's per-user/per-repo levels from forcing a rebuilt, uncached image
  for every Run.
- **Dropping plain HTTP** — the spec asks for HTTP beside `CONNECT`, and `FilterURLs` pins its
  port as tightly as a `CONNECT`'s, so dropping it would buy nothing.
- **`Allow 0.0.0.0/0`** — works today (nothing else is on the proxy's bridge-side network), but
  scoping it to the real internal subnet costs one `docker network inspect` call and closes the
  relay risk outright rather than relying on there being no other tenant yet.
