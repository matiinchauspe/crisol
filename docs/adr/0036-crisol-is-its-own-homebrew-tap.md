# Crisol is its own Homebrew tap

Ticket 40, recording a ruling made in ticket 18's review. The spec had Crisol installed as
`brew install matiinchauspe/tap/crisol`, from a separate `matiinchauspe/homebrew-tap` repo. That
repo does not exist. Tenaza, the other tool Crisol ships beside, is its own tap: its formula lives
in `Formula/` in its own repo (`brew tap matiinchauspe/tenaza`).

## The formula lives in this repo, installed by full name

Matías ruled that Crisol follows Tenaza. `Formula/crisol.rb` lives in this repo, and install is:

```sh
brew tap matiinchauspe/crisol https://github.com/matiinchauspe/crisol
brew install matiinchauspe/crisol/crisol
```

The tap needs its URL, because the repo is not named `homebrew-crisol`. Install uses the full
name, as Tenaza's README does. Homebrew only loads formulae from a tap you trust, and ticket 18's
review found a plain `brew install crisol` refused as an untrusted tap. `brew trust --formula` is
the way out (the command exists in Homebrew 7.0.16, checked with `brew trust --help`).

One repo means the formula ships with the code it installs, and no second repo has to be created
or kept in step.

## The release fills the formula on `main`

A formula carries the sha256 of each binary, and those exist only once the release compiles
them. So the tagged commit can never hold its own checksums. Ticket 18 left them as
placeholders for a human to fill after the tag, which left a formula Homebrew rejects on `main`
until someone did.

After publishing the release, `.github/workflows/release.yml` runs `scripts/formula.ts fill`
against `main`'s `Formula/crisol.rb` with the release's `checksums.txt`, and pushes that commit to
`main`. Then it reads the formula back from `main` and fails on any placeholder left
(`scripts/formula.ts check`). The repo is private on a free plan, where GitHub enforces no branch
protection, so a direct push is allowed (`gh api …/branches/main/protection` returned 403
"Upgrade to GitHub Pro or make this repository public", 2026-11-23).

`fill` replaces whatever `version` and `sha256` values the formula holds, not only placeholders:
from the second release on, the tagged commit carries the previous release's values.

## The release builds with one pinned Bun

`.bun-version` holds the exact Bun version, and `oven-sh/setup-bun@v2` reads it through
`bun-version-file`. setup-bun only warns when it cannot read that file, then falls back to
`package.json` and then to the latest Bun (`src/index.ts` and `readVersionFromFile` in
`src/utils.ts` at its `v2` tag). So the workflow also checks `bun --version` against the file.

The x64 binary is now smoke-tested under Rosetta (`arch -x86_64`). `macos-latest` is the macOS 26
arm64 image, whose build runs `install-rosetta.sh` and whose tests check that `oahd` is running
(actions/runner-images: `README.md`, `images/macos/templates/macOS-26.arm64.anka.pkr.hcl`,
`images/macos/scripts/tests/Rosetta.Tests.ps1`). Bun 1.4.3 ships one x64 binary that targets
SSE4.2 and picks AVX2 code paths at runtime (`docs/bundler/executables.mdx` at `bun-v1.4.3`), so
Rosetta runs it.

## Rejected

- **A separate `matiinchauspe/homebrew-tap` repo.** It would be a second repo to create and
  keep in step, for a single formula.
- **Opening a pull request with the filled formula.** The workflow's own check on `main` could
  only fail until a human merged it, and nothing on this plan requires a review before `main`.
- **Keeping the by-hand fill.** Every tagged release would ship a formula Homebrew rejects until
  someone remembers.

## Amendment 2026-11-25: the filled formula reaches `main` through a pull request

The repo is now public, so GitHub enforces `main`'s ruleset: a pull request with code-owner
review, whose only bypass is the admin role in pull-request mode. The direct push this ADR chose
was rejected (GH013) on v0.1.0 (run 45609381874) and v0.2.0 (run 45710902008): each release
published, then failed with `main` still holding the previous values, until a PR filled the
formula by hand (#4, #7).

The workflow now opens that pull request itself, from a job of its own, `formula`, which runs after
the release job. It fills `Formula/crisol.rb` on `main` from the `checksums.txt` the release
published, not from a fresh build: re-running `formula` alone never recompiles or re-uploads a
binary, so it cannot change a sha256 under a formula `main` already serves. Re-running the release
job does both, since `softprops/action-gh-release` overwrites existing assets. Only `formula` holds
`pull-requests: write`.

It fails on any placeholder left (`scripts/formula.ts check`, on the filled file rather than on
`main`, which still holds the previous release until the merge), force-pushes the commit to
`release/formula-v<version>` and opens a PR from it, or reuses the same-repo PR already open from
that branch. A PR from a fork is never reused, since the repo is public and anyone can name a branch
that way. When `main` already holds the release's values, it opens none. The owner merges the PR,
and `brew install` picks up the release from then on.

`GITHUB_TOKEN` opens the PR, which needs the repo setting "Allow GitHub Actions to create and
approve pull requests" turned on. The approval half of that setting does not weaken `main`: the bot
is not a code owner, so its approval never satisfies the ruleset.

Two premises above no longer hold: "private on a free plan, where GitHub enforces no branch
protection", and the rejection's "nothing on this plan requires a review before `main`".
