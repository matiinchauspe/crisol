# Fetch-back moves the branch only from where the round began

Amends ADR 0020 and ADR 0023, which kept Fetch-back fast-forward only. A Continuation's agent that
amends or rebases its branch, as it commonly does to fix a red Gate, left a branch the host could
not fast-forward to. The fetch was refused, the Run reported `fetchBack: false`, `crisol recover`
retried the same fetch and failed every time, and `gc` skipped the Run as `not-fetched-back`
forever. The work lived only in the Clone, with no supported way back.

## The rule

Fetch-back moves the host branch to the Clone's tip only while the host branch still sits where the
round began. The round's starting point is the sha the Continuation pre-flight already proves the
host and the Clone share (ADR 0023), or no branch at all for a first round. Each round writes it to
the Run lock as `roundStart`, so `crisol recover` applies the same rule to a round that died.

`git fetch` has no compare-and-swap, so Fetch-back now runs in two steps. It fetches the Clone's
objects without moving a ref (`--no-write-fetch-head`, as the scans of ADR 0029 do), then moves the
branch with `git update-ref <ref> <clone tip> <roundStart>`, which git refuses when the ref is not
at the sha it expects. A host branch that moved meanwhile is refused with a message naming where
the round began, where the branch is now, the Clone's tip, and a `git branch` that keeps the Run's
work beside the host's.

- **A fast-forward is always taken**, even from a sha other than `roundStart`: it drops nothing the
  host holds. It also covers a lock written before `roundStart` existed, which falls back to what
  Fetch-back did before: fast-forward, or create a missing branch.
- **A checked-out branch is still refused.** `git fetch` refused to move a branch some worktree has
  checked out, and `update-ref` does not, so Fetch-back checks `git worktree list` itself.

Rejected:
- **A `+` refspec** — it forces whatever the host branch holds, so a commit the user made on it
  during the round would be overwritten.
- **Keeping fast-forward only** — the amend-or-rebase case is the ordinary way an agent fixes a red
  Gate, and it left the work stranded.
