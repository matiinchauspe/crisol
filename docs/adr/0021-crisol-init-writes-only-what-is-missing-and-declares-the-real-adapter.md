# `crisol init` writes only what is missing, and its Sandbox block declares the real Adapter

Ticket 17 onboards a repo: `.crisol/` with Gates and an empty `.crisol/network`, a first learn Run
on offer, and a `## Sandbox` block in the repo's agent instructions that declares two entry points,
run one Task and continue a Run by its branch. The spec fixed those and left the rest open. These
are the choices made.

## Nothing is overwritten

`init` writes `.crisol/config.toml` and `.crisol/network` only when they are absent, and appends the
block only when neither `AGENTS.md` nor `CLAUDE.md` has a `## Sandbox` heading. Both files are
checked, so a repo whose `CLAUDE.md` links to `AGENTS.md` never gets a second block. With neither
file present, `init` creates `AGENTS.md`, since the block is how a dispatcher finds the Sandbox and
a repo with no instructions file would otherwise not declare it at all. A second `init` therefore
changes nothing, and an edited config survives it. Nothing is committed: like `crisol allow
--repo`, `init` only writes the working tree.

## Gates come from three script names

A Gate is created for each of `typecheck`, `lint` and `test` that `package.json` declares, in that
order, so the cheap ones fail first. It runs as `<manager> run <script>`, with the manager the
committed lockfile names (the same rule as the dependency install, ADR 0016), and `npm` without a
lockfile. npm's placeholder `test` script (`echo "Error: no test specified" && exit 1`) is skipped,
because as a Gate it could never go green. A repo without `package.json` gets `gates = []`: the
file exists to edit, and its Runs are `unverified` until someone adds a Gate. Other ecosystems
(`make`, `cargo`) are not detected.

## The block declares `--adapter claude-code`

The ticket wrote both entry points without `--adapter`. `crisol run` still defaults to the scripted
stand-in, so a dispatcher running the entry points as written would get a Run that commits a
placeholder file and comes back `verified` with no agent involved. The block therefore declares
`--adapter claude-code` on both lines. Once the default becomes the real Adapter, the flag stays
valid. The test that runs the declared lines replaces only that flag with `--adapter fake`, because
the suite never calls a model.

The block also says what its caller cannot learn from a dry read: `<ref>` must be a local ref (ADR
0004's Clone sees nothing else), `--gate` replaces the repo's Gates, the three fields to read, and
that `status`, not the exit code, says how a Run ended. A provider failure resolves like the ceiling
and exits 0 (ADR 0017), and so do `parked` and `checkpoint` (ADR 0019).

## The CLI's stand-in ends every turn with a Final message

A real agent always ends its turn with a message, so a caller of the real Adapter always gets
`finalMessage`. The stand-in `crisol run` builds when no `--adapter` is given used to end silently,
and its Run result had no `finalMessage`. It now ends its launch and its Continuation turns with a
fixed message saying no agent worked on the Task. Tests that build their own `FakeAdapter` are
unchanged.

## Accepting the learn offer writes the hosts

ADR 0013 made `crisol run --network learn` print `crisol allow --repo` lines rather than ask and
write, because the y/N prompt and the TOML editor behind it caused every real defect. `init` asks
once anyway, because the ticket makes writing the hosts the point of the offer. The risks ADR 0013
named are gone: the answer is one `y`/`yes` comparison (as `crisol gc` does, ADR 0018), no stdin
reads as a no, and the repo level is now a one-host-per-line file that `crisol allow` already
appends to. Each reached host that `hostsToLearn` would propose goes through that same append, so
it is validated the same way. The file is left uncommitted for review.

The learn Run has a fixed Task (run the Gates and their setup, change no file) and one iteration: a
red Gate still shows the hosts it reached, and resuming the agent would learn nothing new. It runs
through `init`'s own `--adapter`, the stand-in by default like `crisol run`. With the stand-in, only
the dependency install and the Gates reach the network. A Run that fails after computing its Run
result still has its hosts written, and `init` exits 1.

## Not addressed

- Only `package.json` scripts are detected.
- The learn Run leaves its branch in the repo, as every Run does.
- That a real Claude Code Run started from the block's line works end to end is checked only by
  hand, in the release check (ticket 18).
