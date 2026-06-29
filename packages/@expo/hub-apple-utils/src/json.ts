/** Small JSON helpers shared by the `devicectl` / `simctl` output parsers. */

/** `JSON.parse` that logs and returns `undefined` instead of throwing. */
export function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    console.error("[apple-utils] Failed to parse JSON output:", error);
    return undefined;
  }
}

/** Narrow an unknown value to a plain (non-array) object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return `value` when it is a string, otherwise `undefined`. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
