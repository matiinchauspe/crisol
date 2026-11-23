# Gates run only on a clean Clone with HEAD on the Run's branch

Ticket 37: the Gates ran on the Clone's live working tree, while Fetch-back takes only the committed
`refs/heads/<branch>`. An agent that forgot to commit, which agents routinely do, earned `verified`
on a branch that lacked the change.

## The check comes before every round of Gates

Before each round, `checkCommitted` (`src/gates.ts`) asks two things of the Clone: does
`git symbolic-ref --quiet HEAD` name `refs/heads/<branch>`, and is `git status --porcelain` empty.
Untracked files count, since a file the agent created and never added is the commonest way to
forget. A `git status` that fails counts as not clean.

When either answer is no, no Gate runs. The agent is resumed with feedback naming where HEAD is and
what is uncommitted, and the round spends an iteration exactly as a red Gate does, so the iteration
ceiling still bounds an agent that never commits. `gates` in the Run result keeps the last round
that did run (ADR 0030), so a Run that never committed reports `gates: []`.

A Run with no Gates is not checked. It ends `unverified`, which vouches for nothing, and the commit
scan and Fetch-back already describe exactly what was committed.

## The check runs inside the Sandbox

Both git commands run through `sandbox.exec`, never on the host. `git status` executes what the
Clone's `.git` names, such as a `core.fsmonitor` hook, and that `.git` is agent-written (ADR 0029).
Inside `converge`, the check is raced against the wall clock like a Gate, so a hook that never
answers ends the Run at the ceiling (ADR 0030).

Rejected:
- **Committing for the agent** — in the spec the agent commits to its own `.git` (Workspace, q2),
  and a commit Crisol made would put the user's identity on a message nobody wrote.
- **Running the Gates in a fresh checkout of the branch** — it would judge the right tree, but each
  round would pay a second checkout and a second dependency install, and the agent would still learn
  only that a Gate went red, not that its work was never committed.
- **Checking only once, after the last round** — a verdict reached on an uncommitted tree would
  have to be thrown away with nothing left to resume.

## 2026-11-23 — what the dependency install leaves dirty is excused

Review found the check blocking Runs the agent could never unblock. Dependency install runs in the
Clone before the agent launches, and only `npm ci` refuses to touch the lockfile
(`src/dependencies.ts`): `bun install` 1.4.4 rewrote an empty `bun.lock`, read live in
`crisol-base:0.2.0`. A repo whose `.gitignore` lacks `node_modules` also leaves it untracked. Either
leaves `git status --porcelain` non-empty on every round, so the Run could only end at the ceiling.

Ruling (Matías): right after the install, `snapshotInstallDirt` (`src/gates.ts`) records every
path `git status --porcelain -z` names, with the blob `git hash-object` gives its content (`-` for
a directory or a deleted file). `checkCommitted` skips an entry whose path is in the snapshot and
whose content still matches, and still blocks on everything else and on `HEAD` off the branch.

- **Matched by content, not by status line.** A path the install dirtied and the agent then
  changed further, such as a lockfile it regenerated after adding a dependency, is the agent's
  work, and Fetch-back would return the branch without it. Its status line can read the same
  (` M bun.lock`), so only the content tells the two apart. An untracked directory is matched by
  path alone, since what lands in `node_modules/` is the install's.
- **Taken once per Run and kept in `install-dirt.json` in the Run dir.** A Continuation reuses the
  Clone, so a snapshot after its own install would also hold whatever the round before left
  uncommitted, and would excuse it. A Continuation reads the first round's snapshot instead; a Run
  that predates the file excuses nothing.
- **Outside the wall clock, with no race.** The snapshot is part of the install, which runs before
  the clock starts. It only ever runs on a first round, in a Clone whose `.git` the host just made
  and no agent has written.
- A `git status` that fails during the snapshot fails the Run before the agent launches, as a
  failed install does, rather than guessing what to excuse.

Rejected:
- **A frozen-lockfile install** (`bun install --frozen-lockfile` and the like): a repo whose
  lockfile is out of date would fail its install before the Run starts, and it does nothing for an
  untracked `node_modules`.
- **Snapshotting before and after every round's install**: in a Continuation, the install's dirt
  from the first round is already present before the second install, so it would never be excused.
