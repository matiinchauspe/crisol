# A Continuation re-enters its Run's own dir, and keeps only the session transcripts

Ticket 21 lets a caller send review changes back to the same agent, with its context, on the same
branch: `crisol run --continue <branch>`. The spec fixed the behaviour (find the Run by its branch,
re-take its Run lock and a Slot, a new Sandbox over the same Clone, resume the session, run the
Gates honouring the Stop line, Fetch-back fast-forward only, rewrite `result.json`) and left the
rest to the implementation.

## The session store is a mount the Adapter names

An Adapter may declare `sessionStore`, the path inside the Sandbox where its agent keeps sessions.
Crisol mounts `runs/<id>/sessions/` there on every Run, not only on a Continuation, so any finished
Run can be continued. After every turn it writes the Adapter's `sessionId()` to `runs/<id>/session-id`.
A Continuation's first turn is the Adapter's `continueSession(ctx, sessionId, request)`; after it, a
red Gate resumes the session through `resumeWithFeedback` as in any Run. All three members are
optional, so an existing Adapter still satisfies the interface; one without `continueSession` is
refused before anything starts.

The Claude Code Adapter's store is `~/.claude/projects`, where `--resume` finds a session by working
directory, and not the whole `~/.claude` the spec names. A mount over `~/.claude` would hide the
`settings.json` the Agent layer bakes in, and with it the attribution settings ADR 0008 relies on.
That `--resume` finds the session from the transcripts alone is verified only through the fake
Adapter; the live check by a human is still owed.

## A Continuation is its Run, not a new one

It keeps the run id and the Run dir. It re-takes the Run's own lock, so a second Continuation of the
same Run, or `crisol recover`, waits it out. The log is only appended to, and carries the request;
`prompt` keeps what the agent received at launch. `result.json` is rewritten whole: the same `run`,
`branch` and `base`, and this round's `status`, `iterations`, `gates`, `network`, `blocked`,
`warnings`, `fetchBack`, `finalMessage` and a new `finishedAt`, which restarts `crisol gc`'s clock.

The Run is found among the finished Runs of the host repo it runs in whose Run result names the
branch. None, or more than one, is refused before any side effect, naming the branch, and the Runs
when there are several. A Run whose Clone `crisol gc` collected, or that kept no session, is refused
the same way. A same-named branch in another host repo is not a claim.

## What a round reuses and what it does not

- The prompt is the Preamble again with the request as the Task, so the Gates and the Stop line are
  named in the turn that needs them.
- The Gates are `--gate` when given, else the ones the Run had, kept in `runs/<id>/gates.json`, else
  the repo's. A caller that passed `--gate` to the Run need not repeat it.
- `--name`, `--base`, `--detach` and several Tasks are refused: a Continuation has its Run's branch
  and base, and one request.
- Fetch-back is unchanged. Its refspec has no `+`, so a host branch that moved meanwhile is refused,
  `fetchBack` is `false`, and `crisol recover` retries it without ever forcing.
- A Continuation that ends before it holds a Slot leaves `result.json` as the last round wrote it.
- Commit warnings scan only the round's own commits, and the disk tally adds only what the round grew.

## Known limits

- While a Continuation runs, `crisol status` shows the previous round's Run result: it reads a
  `result.json` before it looks at the lock.
- git refuses to fetch into a branch checked out in the host repo or one of its worktrees, so a
  Continuation of a branch someone has checked out fails at Fetch-back, reported.
- The Agent layer may change between rounds (a new Claude Code version); a session it cannot resume
  fails the Continuation, reported, never a silent fresh session.
