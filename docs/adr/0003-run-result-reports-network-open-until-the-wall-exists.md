> **Superseded 2026-11-14 by
> [docs/adr/0012-network-wall-is-tinyproxy-on-an-internal-network-with-the-allowlist-bind-mounted.md](./0012-network-wall-is-tinyproxy-on-an-internal-network-with-the-allowlist-bind-mounted.md).**
> Ticket 06 built the wall this ADR named as still missing; `network` now reports `"allowlist"` by
> default. Left below exactly as written, since it is a record of ticket 01's own decision, not of
> the wall's design.

# Run result reports `network: "open"` until the Allowlist wall exists

Ticket 01 builds no network wall at all — the Sandbox runs on Docker's ordinary default network,
reachable anywhere the host can reach. Of the spec's three `network` values (`allowlist`, `learn`,
`open`), `"open"` is the only one that describes what is ACTUALLY happening rather than claiming a
protection this ticket does not provide. Chosen over defaulting to `"allowlist"` (would misreport
an unenforced wall as enforced) or inventing a fourth value (the spec calls its enum closed — "the
Status has three values and never more" — and widening a different field's enum here would still
be the less conservative move). The Allowlist-wall ticket replaces this literal with the real
decision once a wall exists to report on; nothing here should be read as that design.
