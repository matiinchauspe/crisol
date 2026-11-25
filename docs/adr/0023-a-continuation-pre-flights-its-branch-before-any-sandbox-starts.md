# A Continuation pre-flights its branch before any Sandbox starts

Ticket 24: a branch checked out in the host repo or one of its worktrees, or one whose tip in the
host no longer matches its Clone's, made `findContinuedRun` run a full agent round and only fail at
Fetch-back — two of ADR 0020's "Known limits". The round's new commits land in the Clone on top of
a tip that no longer matches the host's, so the Clone diverges for good: Fetch-back's refspec has no
`+` and never will, so no later Continuation, `recover` or `gc` can reconcile it either.

## Both checks run in `findContinuedRun`, before a Slot or a Sandbox

`assertBranchContinuable` runs right after `findContinuedRun` confirms the Run's Clone still
exists, before it reads the kept session id — the earliest point a Continuation has both a host
repo and a Clone to compare. It checks, in order:

- **Checked out**: `git worktree list --porcelain` over the host repo, parsed for a `branch
  refs/heads/<name>` line, names the worktree holding that line (the host repo's own checkout is
  one of the entries). `git fetch` refuses to update whichever branch that worktree currently has
  checked out.
- **Tip mismatch**: the branch's sha in the host repo against its sha in the Run's own Clone
  (`branchSha` on each). The Clone still holds whatever it last had — nothing deletes a Run's
  branch from it — so the two can differ either way: the host may have moved past the Clone, or
  the Clone may be ahead because an earlier Fetch-back never completed (`fetchBack: false`).

Either refusal names what it found — the worktree path, or both shas — and throws before
`prepareRun` reaches `reserveContinuation` or `acquireSlot`, so no Run id is reserved and nothing
on disk changes. The tip-mismatch refusal reports both shas and that a Continuation needs them
equal; it never guesses which side is ahead or tells the caller to fast-forward or reset either
one — the wrong guess would be advice to discard real work, so the choice is left to a human who
can see both histories.

## What this leaves unowned

Fetch-back's own refspec (no `+`, ADR 0020) stays the last line of defense: a branch that passes
both checks here can still move between this pre-flight and the round's own Fetch-back, and that
race is still refused there, `fetchBack: false`, exactly as before. This ticket only moves the
common case earlier, before a round runs on a base already known to be lost.
