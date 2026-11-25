// SPIKE: linux is accepted only to learn whether the Sandbox works on a CI runner.
export const SUPPORTED_PLATFORMS: readonly string[] = ["darwin", "linux"];

/**
 * Read through this function, never `process.platform` directly, so a test can pin a
 * platform via `CRISOL_PLATFORM`. The override can only force failure, never fake success:
 * a value in `SUPPORTED_PLATFORMS` is ignored, so a stray env var can't claim
 * support on an unsupported host. Empty string is treated as unset.
 */
export function currentPlatform(): string {
  const override = process.env.CRISOL_PLATFORM;
  if (override !== undefined && override !== "" && !SUPPORTED_PLATFORMS.includes(override)) {
    return override;
  }
  return process.platform;
}

export const UNSUPPORTED_PLATFORM_MESSAGE = "Crisol v1 supports macOS; Linux is planned.";

/** Called before any arg parsing or Docker/git call, so the platform message always wins over those. */
export function assertSupportedPlatform(): void {
  if (!SUPPORTED_PLATFORMS.includes(currentPlatform())) {
    process.stderr.write(`${UNSUPPORTED_PLATFORM_MESSAGE}\n`);
    process.exit(1);
  }
}
