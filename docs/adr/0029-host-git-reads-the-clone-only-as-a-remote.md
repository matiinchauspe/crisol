# Host git reads the Clone only as a remote

Ticket 32: the agent writes the Clone's `.git` — its config, its hooks, its `info/attributes` — and
the Clone is bind-mounted, so whatever it writes is there on the host too. The host ran `git log`
(the commit scan), `git diff` (the Allowlist scan), and on a Continuation `git checkout`, all with
`-C` on the Clone, so git ran what that `.git` named, on the host, as the user: a
`diff.<driver>.textconv`, `log.showSignature` with `gpg.program`, a `post-checkout` hook,
`core.fsmonitor`. A test planting all four saw every one of them fire. Amends ADR 0018 and ADR
0024, whose branch checks read the Clone with `rev-parse` and `show-ref` inside it.

## The rule

The Clone's `.git` is agent-written, so host git never runs a command inside it. Git's own
documentation draws the same line (`git(1)`, SECURITY, in current releases): running git commands in a `.git` that comes
from an untrusted source is not safe, while `upload-pack`, the server side of a fetch, is restricted
to the options and hooks that are safe to serve. So the host reads a Clone only as a remote:

- **A branch's tip** — the Continuation pre-flight, `runsNamingBranch`, `recover`, `gc`, and
  Fetch-back's own verification — comes from `git ls-remote <clone> refs/heads/<branch>`
  (`cloneBranchSha`).
- **The commit and Allowlist scans** fetch the branch's objects into the host repo without moving a
  ref (`--no-write-fetch-head`), then run `git log` and `git diff --no-textconv` there, over
  `<from>..<tip>` with the tip from `ls-remote`. A sha, never the bare branch name, which a
  same-named tag would shadow: `refs/tags` resolves before `refs/heads`.
- **A Continuation's checkout** runs inside the Sandbox, right after it starts, where the hooks,
  filters and fsmonitor it fires reach only the Sandbox.

The one exception is `checkoutNewBranch`, which runs on a Clone `cloneLocal` has just made, before
any Sandbox mounts it.

## A `.git` that is no longer a directory is refused

`upload-pack` follows a gitfile, so a `.git` rewritten as `gitdir: <host repo>/.git` would have the
host read, and fetch from, the host repo itself. Before any of the reads above, `lstat` must find
`.git` a directory — a symlink fails it too — or the call throws, naming the path. A Run reports it
as its Fetch-back error, a Continuation as its refusal, `recover` as a failed outcome, and `gc` skips
the Run as `clone-refused` rather than delete a Clone it could not verify.

## Fetch-back brings back one ref

Fetch-back's `git fetch` takes `--no-tags`. Without it git follows any tag pointing into the fetched
history, so a tag the agent made — `npm version` makes one — landed in the host repo.

## What this leaves unowned

A `.git` that is a directory can still name another repo's object store or common dir
(`objects/info/alternates`, `commondir`); no test covers whether `upload-pack` follows either.
Either would change what the host reads, not what it runs.
