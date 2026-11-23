# The Agent layer builds on Alpine, Debian or Ubuntu, and takes uid 1000

Ticket 39. Review over the 0.1.0 deliverable found that the Agent layer only built on an Alpine
Project layer with uid 1000 free. ADR 0008 wrote `apk add` and BusyBox's `adduser -D -u 1000`,
and ADR 0028 pinned Tenaza's musl builds, because every Project layer at the time was Crisol's
own Alpine default. A repo's `.crisol/Dockerfile` is free to start from anything, and the spec
says the Project layer "knows nothing about agents". So the first `node:*-alpine` or Debian base
a user brought failed the build: `node` already holds uid 1000 there, and Debian has no `apk`.

The ticket allowed either supporting both bases or refusing them with the constraint named. The
spec's Project layer settles it: support them. Crisol owns everything agent-specific, so the
Agent layer adapts to the project's image, not the other way round.

## The shell picks the package manager at build time

`installPackagesStep` writes one `RUN` that uses `apk` where it exists, else `apt-get`. The
Dockerfile text, and so the cache key, stays the same whatever the base. The Agent layer now also
installs `bash`, `git` and `ca-certificates`. Crisol runs `git` inside the Sandbox and the agent
user's shell is `bash`, and `node:*-alpine` and `debian:*-slim` carry neither. `libgcc` and
`libstdc++` stay Alpine-only, since glibc images already carry both.

## An image with neither is refused before `docker build`

Before building, `assertInstallableBase` runs `command -v apk || command -v apt-get` in the Project
layer image. Where it fails, the Run stops in pre-flight with `UNSUPPORTED_BASE_MESSAGE`. A failed
`docker build` would print the same message, since the `RUN`'s own fallback echoes it, but Docker
puts it after the full text of the failing step, verified live. The probe only runs when the
Agent layer is not cached, through a new `beforeBuild` option on `ensureImageFromDockerfile`.

An image with no package manager and an image with no `/bin/sh` both exit 127, so both get the
message, verified live. Exit 125 is `docker run` failing before the image ran, verified live
with an image that does not exist. That case reports Docker's own error instead, since it says
nothing about the base.

## uid 1000 is taken back from any account that holds it

The step looks the uid up in `/etc/passwd`, removes the account it finds (`userdel`, else
BusyBox's `deluser`), then creates `agent` (`useradd`, else `adduser -D`). That account's files
keep their numeric owner, so they pass to `agent`. Verified live: on `node:22-alpine`,
`/home/node` is owned by `agent` afterwards, and `id` reports `uid=1000(agent) gid=1000(agent)`
on `node:22-alpine`, `ubuntu:24.04` and `debian:bookworm-slim`.

The layer opens with `USER root`, since a Project layer may end on its own `USER` and the install
steps need root. It still ends on `USER agent`.

## Tenaza's asset is picked by libc as well as by arch

`TenazaRelease.assets` is keyed by `musl` / `glibc`, then by `uname -m`. v0.5.2 publishes
`tenaza-linux-arm64` and `tenaza-linux-x64` glibc builds beside the musl ones (`gh release view
v0.5.2 -R matiinchauspe/tenaza --json assets`). The step treats an image as musl when
`/lib/ld-musl-<arch>.so.1` exists, the loader only musl ships. The glibc build needed no extra
package on Debian or Ubuntu, verified live with `tenaza --version`.

This amends ADR 0008's user creation and ADR 0028's musl-only release, and leaves their other
decisions as written.

## What stays a constraint

The Project layer is still built from stdin with no build context, so `COPY` and `ADD` of a local
path fail. `COPY --from=<image>` works, verified live. The README's "What a `.crisol/Dockerfile`
must allow" lists this with the distro, uid and `USER` constraints.

The Agent layer's cache key is still (Project layer image, agent version, Tenaza version), so an
Agent layer built before this change keeps its tag and is reused. Only an Alpine base could have
built one, and that build behaves the same.

## Rejected

- **Refusing every non-Alpine base.** It would push agent concerns into the project's
  Dockerfile, which the spec keeps free of them.
- **A uid other than 1000, or a free one picked at build time.** ADR 0008 checked bind-mount
  ownership as uid 1000. A moving uid would make that check depend on the base.
- **Keeping the existing uid-1000 account and running as it.** Its name and home differ per base,
  while the Adapter's `sessionStore` and settings live under `/home/agent`.
