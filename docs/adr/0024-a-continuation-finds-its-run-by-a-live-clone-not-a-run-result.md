# A Continuation finds its Run by a live Clone, not just a Run result

Ticket 25: ADR 0020's ownership rule — "the Run... whose Run result names the branch" — counted a
Run that never made a Clone (ended before a Slot) or whose Clone `crisol gc` already collected the
same way as one a Continuation can actually resume. Once a branch name was reused after the first
Run's Clone was gone, both Runs' results named it, so `findContinuedRun` refused it as claimed by
two Runs forever — reusing a `--name` could never recover from that.

## A claim now needs the Clone itself

`runsNamingBranch` lists every finished Run whose `result.json` names a branch, each flagged with
whether its own Clone, at `~/.crisol/runs/<id>/repo/`, still has a local branch by that name
(`branchExists`, the same check Fetch-back and `gc`'s own live-branch check already use). Only the
flagged ones are claimants (`runsOwningBranch`): a Run that ended before it ever held a Slot made no
Clone at all; one `crisol gc` collected had its Clone removed on purpose. Either way nothing is left
to mount into a new Sandbox or resume a session from, so neither counts.

This also fixes the permanent refusal: once the first Run's Clone is gone, only the second Run
(whose Clone is live) claims the reused name, so `--continue` resumes it instead of refusing both
forever.

## The refusal still names a true cause when nobody is left to resume

A branch truly nobody's result names gets the original message. One some Run's result names but
none of the matching Runs' Clones hold gets a different one, built per Run from what `result.json`
already settled, never guessed: `crisol gc` only ever collects a Run whose Fetch-back already
completed (`planGc`'s own first check), so a claimant with `fetchBack: true` and no Clone can only
have lost it to `gc` — and one with `fetchBack: false` never made a Clone to begin with, since
nothing else ever removes `repo/`. The message never blames `gc` for the second case, and never
claims nobody named the branch when a Clone-less Run's result still does.

## What stays unowned

Once exactly one Run owns a branch, `findContinuedRun`'s own `existsSync` check on its Clone is
reachable only through a race — `crisol gc` collecting it in the window between
`runsNamingBranch`'s read and this one — so its message still correctly blames `crisol gc`: nothing
else removes a Clone. Amends ADR 0020, which first stated the Run-result-only rule.
