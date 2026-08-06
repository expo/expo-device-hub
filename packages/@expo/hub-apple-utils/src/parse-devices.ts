import { isRecord, safeJsonParse } from "./json";
import { type AppleUtilsResult, result } from "./errors";
import type { AppleDevice } from "./types";

/**
 * Parse the JSON written by `devicectl list devices --json-output`.
 *
 * Returns the `result.devices` array as `value`, or an empty array when the
 * payload is missing, malformed, or not shaped as expected. Malformed JSON is
 * returned in `error`. Never throws.
 */
export function parseDevicesJson(json: string): AppleUtilsResult<AppleDevice[]> {
  const parsed = safeJsonParse(json);
  if (parsed.error) return result([], parsed.error);
  if (!isRecord(parsed.value)) return result([]);

  const payloadResult = parsed.value.result;
  if (!isRecord(payloadResult)) return result([]);

  const devices = payloadResult.devices;
  if (!Array.isArray(devices)) return result([]);

  return result(devices.filter(isRecord) as AppleDevice[]);
}
