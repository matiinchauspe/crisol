# The Clone copies git objects; it never hardlinks them to the host's

Amends the crisol-v1 spec's grill decision Q2 ("Workspace — local Clone + Fetch-back"), which
specified `git clone --local` of the host repo and parenthetically noted "(hardlinked objects)" as
the expected, ordinary behaviour of `--local` on a shared filesystem. `cloneLocal` (`src/git.ts`)
now passes `--no-hardlinks` as well, so the Clone's `.git/objects/` holds independent copies, never
the same inodes as the host repo's.

## Why the original decision was unsafe

`git clone --local` hardlinks loose objects whenever the Clone and the host repo sit on the same
filesystem — the exact case here, since `~/.crisol/runs/<id>/repo/` and the host repo are both
ordinary paths on the same machine. A hardlink means the Clone's object file and the host's are the
SAME inode: writing through one path writes through the other.

The Sandbox bind-mounts the Clone at the same absolute path it has on the host (q6) and the
container's processes write as the HOST user — a bind mount changes where a path is visible, not
who the writer is, and v1 ships no user-namespace remapping. So an unattended agent inside the
Sandbox can `chmod u+w` an object file that looks like it belongs only to its own throwaway Clone,
overwrite it, and corrupt the host's `.git/objects` through the exact same inode. `git fsck` on the
HOST repo then reports it corrupt — permanent damage to the one repo Crisol exists to protect,
caused by a Run that was supposed to be able to damage nothing but its own Clone.

This was found in the round-1 review of ticket 01 and a test proves it both ways: before this
fix, a fake-Adapter step that overwrites an object file from inside the Sandbox leaves the host
repo's `git fsck` reporting corruption; after it, the same step leaves the host untouched
(`test/clone-isolation.test.ts`).

## Decision

`cloneLocal` passes `git clone --local --no-hardlinks`, forcing a real copy of every object even on
a shared filesystem. The Clone is slower to create and heavier on disk than a hardlinked clone, but
it is now actually isolated — the "worst it can damage is its own Clone" claim in the spec's
Solution section becomes true for the object store, not only for the refs a worktree would have
shared.

## Rejected

- **Leaving `--local` as-is and relying on file permissions** — rejected per the problem statement
  above: the bind mount preserves host-user write access, so no permission bit protects the shared
  inode.
- **Read-only bind mount for `.git/objects` specifically** — would also block the agent's own
  legitimate writes (new objects from its own commits) and `fetchBack`'s later reads; singling out
  one subdirectory for a different mount mode adds complexity `--no-hardlinks` avoids entirely.
- **Dropping `--local` for a non-local clone (e.g. `file://` without hardlinks, or a full
  network-style clone)** — `--local` without hardlinking is exactly a non-local-style copy already;
  `--no-hardlinks` gets the same safety without losing `--local`'s fast-path optimizations that
  don't involve sharing inodes (e.g. it still avoids a full protocol round-trip).

## Spec amendment

`spec.md`, "Workspace — local Clone + Fetch-back (q2)": "(hardlinked objects)" is replaced with
"(objects copied, not hardlinked — amended 2026-10-29, see crisol ADR 0004)".

## Amendment 2026-11-05: `--local --no-hardlinks` still copied dangling objects; `--no-local
file://` replaces it

This ADR's own "Rejected" section above dismissed dropping `--local` for a non-local-style clone,
reasoning that `--no-hardlinks` already got the same safety without losing `--local`'s fast-path
optimizations. That reasoning covered the threat this ADR set out to fix — a hardlinked object
sharing an inode with the host — but missed a DIFFERENT one, found in the round-2 review of ticket
01: `git clone --local` (with or without `--no-hardlinks`) still performs git's filesystem-clone
optimization, which copies the WHOLE `.git/objects/` directory wholesale, dangling objects
included. A secret that was `git add`ed, `git stash`ed, and later `git stash drop`ped is unreachable
from any ref (`git log --all` never mentions it) but stays physically in the host's object store
until a `git gc` runs — and the `--local --no-hardlinks` Clone copied it anyway, readable from
inside the Sandbox via `git cat-file`. Reproduced in scratchpad and confirmed by `test/clone-secret-isolation.test.ts`.

### Decision

`cloneLocal` now runs `git clone --no-local file://<hostRepoPath>` instead of `--local
--no-hardlinks`. The explicit `file://` URL forces `--no-local`'s normal transport-protocol
negotiation even though the repo is on the same machine — unlike the filesystem fast-path, that
negotiation only ever walks and transfers objects REACHABLE from some ref. A dangling object never
crosses into the Clone at all, regardless of what it's called or how it got dangling.

### Cost

Packing time per Run, unmeasured on a large repo — the normal transport negotiation does real
work (enumerating reachable objects, building a pack) that the filesystem fast-path skipped
entirely. `--no-hardlinks` itself is now moot: a `--no-local` clone was never going to hardlink
anything in the first place, so it is dropped from the invocation rather than kept as a no-op flag.

### Rejected (this round)

- **Keeping `--local --no-hardlinks` and separately pruning the host's dangling objects before
  every Clone** (e.g. `git gc --prune=now` on the host) — rejected: it would mutate the HOST repo
  as a side effect of running a Run, is slower than cloning once, and still leaves a window between
  a `git stash drop` and the next prune where the secret is copyable.
- **Keeping `--local` and excluding `.git/objects` from being filesystem-copied, unpacking only
  reachable objects by hand** — reimplements exactly what git's own non-local clone transport
  already does correctly; strictly more code for the same result.

### Spec amendment (second)

`spec.md`, "Workspace — local Clone + Fetch-back (q2)": "`git clone --local` of the host repo into
`~/.crisol/runs/<id>/repo/` (objects copied, not hardlinked — amended 2026-10-29, see crisol ADR
0004)" is replaced with "`git clone --no-local file://<host repo>` of the host repo into
`~/.crisol/runs/<id>/repo/` (reachable objects only, never the host's dangling ones — amended
2026-11-05, see crisol ADR 0004's second amendment)".
