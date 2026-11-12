export const SUPPORTED_PLATFORM = "darwin";

/**
 * Read through this function, never `process.platform` directly, so a test can pin a
 * platform via `CRISOL_PLATFORM`. The override can only force failure, never fake success:
 * a value equal to `SUPPORTED_PLATFORM` is ignored, so a stray env var can't claim macOS
 * support on an unsupported host. Empty string is treated as unset.
 */
export function currentPlatform(): string {
  const override = process.env.CRISOL_PLATFORM;
  if (override !== undefined && override !== "" && override !== SUPPORTED_PLATFORM) {
    return override;
  }
  return process.platform;
}

export const UNSUPPORTED_PLATFORM_MESSAGE = "Crisol v1 supports macOS; Linux is planned.";

/** Called before any arg parsing or Docker/git call, so the platform message always wins over those. */
export function assertSupportedPlatform(): void {
  if (currentPlatform() !== SUPPORTED_PLATFORM) {
    process.stderr.write(`${UNSUPPORTED_PLATFORM_MESSAGE}\n`);
    process.exit(1);
  }
}
