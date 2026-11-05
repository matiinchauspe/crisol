export const SUPPORTED_PLATFORM = "darwin";

/**
 * Crisol v1 is macOS-only (spec, "Stack and distribution" q14/q18) — the
 * only OS-dependent code (SecretStore, SlotLock) is Darwin-specific, and
 * neither exists on Linux yet. Read through this one function, never
 * `process.platform` directly, so a test can pin a platform with
 * `CRISOL_PLATFORM` without actually running on it — the same test-seam
 * convention as Tenaza's `TENAZA_RUN_SHELL` (env override, falls back to
 * the real thing).
 *
 * `CRISOL_PLATFORM` can only force a FAILURE, never fake success: a value
 * equal to `SUPPORTED_PLATFORM` ("darwin") is ignored and the real
 * `process.platform` decides instead. Without this, the override could be
 * used (by a stray env var or a misconfigured CI runner) to claim macOS
 * support on a host that genuinely doesn't have it.
 *
 * An empty-string override is treated the same as unset (round-2 review
 * extra, mirroring `crisolHome()`'s own rule) — otherwise a stray
 * `CRISOL_PLATFORM=` in the environment would make Crisol report itself as
 * unsupported even on a genuinely supported macOS host.
 */
export function currentPlatform(): string {
  const override = process.env.CRISOL_PLATFORM;
  if (override !== undefined && override !== "" && override !== SUPPORTED_PLATFORM) {
    return override;
  }
  return process.platform;
}

export const UNSUPPORTED_PLATFORM_MESSAGE = "Crisol v1 supports macOS; Linux is planned.";

/**
 * The ticket's own wording: "exits AT ONCE". Called first thing in `main`,
 * before any argument parsing, Docker or git call — a non-macOS host never
 * gets far enough to discover it's also missing Docker, or that its
 * arguments were malformed; the platform message always wins.
 */
export function assertSupportedPlatform(): void {
  if (currentPlatform() !== SUPPORTED_PLATFORM) {
    process.stderr.write(`${UNSUPPORTED_PLATFORM_MESSAGE}\n`);
    process.exit(1);
  }
}
