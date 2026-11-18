# The Final message is what a turn resolves with, and the Stop line is its last line

Ticket 20 keeps the agent's last message in the Run result and lets an agent that stops on purpose
end the Run without being pushed back to work. The spec fixed the behaviour and left the wording of
the marker, and how the message reaches `run()`, to the implementation.

## A turn resolves with its message

`Adapter.launch` and `Adapter.resumeWithFeedback` now resolve with the agent's last message of that
turn (`Promise<string | void>`, amending the `Promise<void>` ADR 0005 sketched). The message is the
turn's own output, so it travels with the turn rather than through a separate getter that could be
read out of step with it. `void` stays allowed so an Adapter that cannot read a message still
satisfies the interface; its Runs simply carry no `finalMessage`. The Claude Code Adapter returns
the `result` field of `-p --output-format json`, untouched.

`run()` keeps the latest turn's message only: a resume that returns nothing clears the one before
it, so `finalMessage` is never an earlier iteration's words presented as the last.

## The marker is `CRISOL-STOP: parked` or `CRISOL-STOP: checkpoint`, on the last non-blank line

Exact match after trimming the line, and only the last non-blank line counts. A Stop line quoted
mid-message, or one naming a reason Crisol does not know, is not a stop: the Gates run as usual. An
upper-case prefix with Crisol's name keeps it from colliding with prose an agent writes anyway.

## A Stop line is read before the Gates, with or without any declared

It ends the converge loop before Gates run, so a stopped Run with no Gate declared is `parked` or
`checkpoint`, not `unverified`. `gates` keeps whatever ran in an earlier iteration of the same Run:
it is the record of what ran, and a launch-time stop leaves it empty. `reason` stays unset, as it
is for every status but `not-converged`.

## A stop resolves `run()`

`parked` and `checkpoint` are finished Runs, like `verified`: `run()` resolves and the CLI exits 0.
A caller tells them apart by `status`, the same way it reads a provider failure.
