# A Run reads `.crisol/` from its base commit

Amends ADR 0016, which read the Project layer from the host working tree, and the other repo
declarations that followed it (Gates, `env` secrets, the repo Allowlist level, `services.yml` and
`.crisol/prompts`). Each was read from the host's working tree, uncommitted edits included, while
the Clone, and so the lockfile, came from the commit the Run's branch is cut from.

The two diverge whenever the host is not on the Run's base. In a walk that dispatches
`--base <previous ticket branch>` while the host sits on `main`, a Gate or Service the previous
ticket added never ran, and the Run could still report `verified`. An uncommitted edit to
`.crisol/config.toml` changed what `verified` meant for that one Run, with nothing in the Run to say
so.

## The rule

Every `.crisol/` declaration a Run reads is read as its `baseSha` commits it, through
`git cat-file blob <baseSha>:<path>`, which is the file the Clone holds. A file the commit does not
have reads as absent, the same as an unconfigured repo. A Continuation reads from the `baseSha` its
first round recorded, so every round of one Run sees one set of declarations.

- **Task, Template and `--context` files** are not `.crisol/` declarations. `--file` and
  `--context` still read the user's own paths; only the repo-level `--prompt` template moves to the
  base. A one-shot template (a pipe) must now be a user-level file, as a FIFO cannot be committed.
- **A fan-out resolves its base once**, before it reads the shared template, so every Run of it
  reads the same commit.
- **A declaration error names the commit**, as `.crisol/services.yml (as committed at <sha>)`, so a
  user who edited the working tree is not sent to a file that was never read.
- **The advice after a Run is not a Run's read.** `crisol run --network learn` still compares the
  hosts it reached with the host's working tree, because the lines it prints are for the user to
  paste there.

- **Committing is what makes a declaration take effect**, so the messages say so. `crisol init` and
  `crisol allow --repo` end by saying the next Run reads `.crisol/` from the commit it is cut from
  and that the file takes effect once committed, where they used to say only "to share it".
- **`crisol run` warns about an uncommitted `.crisol/`.** It names each file with uncommitted
  changes, says this Run reads `.crisol/` as its base commit holds it (with `--base`, perhaps
  another branch than the one checked out), and carries on. The CLI prints it once, before a
  fan-out starts; a detached child does not repeat its parent's. `crisol init`'s learn Run calls the
  library directly with the fresh Gates, so it prints none: `init`'s closing message covers it.

Rejected:
- **Reading the working tree and refusing when it differs from the base** — it fails the ordinary
  case of a Run cut from another branch, and the fix would be to check out the base, which a Run
  never does to the host.
- **Reading from the Clone after it exists** — the declarations validate before any side effect
  (no Clone, no branch, no `docker run`), and a Clone is exactly such an effect.
