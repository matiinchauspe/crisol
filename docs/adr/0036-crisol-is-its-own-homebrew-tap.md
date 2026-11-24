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
