import type { AppleDevice } from "./types";

/**
 * Parse the JSON written by `devicectl list devices --json-output`.
 *
 * Returns the `result.devices` array, or an empty array when the payload is
 * missing, malformed, or not shaped as expected. Never throws.
 */
export function parseDevicesJson(json: string): AppleDevice[] {
  const payload = safeJsonParse(json);
  if (!isRecord(payload)) return [];

  const result = payload.result;
  if (!isRecord(result)) return [];

  const devices = result.devices;
  if (!Array.isArray(devices)) return [];

  return devices.filter(isRecord) as AppleDevice[];
}

function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    console.error("[apple-utils] Failed to parse devicectl JSON output:", error);
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
