// Intl only, so the browser bundle can import it.

export const HOST_TIME_ZONE = "host";

const HOST_ALIASES = new Set(["host", "system", "default", "auto", "none", "reset"]);
// ICU resolves each of these to itself, not to UTC, so they are folded here instead.
const UTC_ALIASES = new Set(["utc", "gmt", "z", "zulu", "etc/utc", "etc/gmt"]);

/** Always starts with UTC, which V8 leaves out of its list. */
export function supportedTimeZones(): readonly string[] {
  let zones: readonly string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {}
  return ["UTC", ...zones.filter((zone) => zone !== "UTC")];
}

/** `GMT+9` / `GMT-3:30` at `at`, or "" for a zone ICU does not know. */
export function timeZoneOffsetLabel(zone: string, at = new Date()): string {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
        .formatToParts(at)
        .find((part) => part.type === "timeZoneName")?.value ?? ""
    );
  } catch {
    return "";
  }
}

/** Bare offsets are refused: ICU accepts them, `TZ` does not. */
export function normalizeTimeZone(value: string): string | null {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (!lower) return null;
  if (HOST_ALIASES.has(lower)) return HOST_TIME_ZONE;
  if (UTC_ALIASES.has(lower)) return "UTC";
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
    return /^[+-]/.test(resolved) ? null : resolved;
  } catch {
    return null;
  }
}
