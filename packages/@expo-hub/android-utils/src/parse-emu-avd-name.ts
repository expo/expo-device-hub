/**
 * Parse the output of `adb -s <serial> emu avd name`.
 *
 * The console replies with the AVD name on its own line followed by an `OK`
 * status line (or `KO` on error). Returns the AVD name, or `null` when the
 * command failed or returned no name. Never throws.
 */
export function parseEmuAvdName(stdout: string | null): string | null {
  if (!stdout) return null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "OK") continue;
    if (line === "KO" || line.startsWith("KO:")) return null;

    return line;
  }

  return null;
}
