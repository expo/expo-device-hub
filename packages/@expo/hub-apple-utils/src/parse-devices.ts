import { type AppleUtilsResult, result } from "./errors";
import { asString, isRecord, safeJsonParse } from "./json";
import type { AppleDevice } from "./types";

/**
 * Parse the JSON from `xcrun simctl list devices --json`.
 *
 * `simctl` groups devices by runtime identifier. This flattens those arrays and
 * adds the runtime identifier plus its platform and OS version to every device.
 * Entries without a UDID are dropped. Malformed JSON is returned in `error`.
 * Never throws.
 */
export function parseDevicesJson(json: string): AppleUtilsResult<AppleDevice[]> {
  const parsed = safeJsonParse(json);
  if (parsed.error) return result([], parsed.error);
  if (!isRecord(parsed.value)) return result([]);

  const devicesByRuntime = parsed.value.devices;
  if (!isRecord(devicesByRuntime)) return result([]);

  return result(
    Object.entries(devicesByRuntime).flatMap(([runtimeIdentifier, devices]) => {
      if (!Array.isArray(devices)) return [];

      const { platform, osVersion } = parseRuntimeIdentifier(runtimeIdentifier);
      return devices
        .filter(isRecord)
        .map((device) => toDevice(device, runtimeIdentifier, platform, osVersion))
        .filter(hasUdid);
    }),
  );
}

function toDevice(
  device: Record<string, unknown>,
  runtimeIdentifier: string,
  platform: string | null,
  osVersion: string | null,
): AppleDevice {
  return {
    ...device,
    udid: asString(device.udid) ?? "",
    name: asString(device.name) ?? "",
    state: asString(device.state) ?? "",
    isAvailable: device.isAvailable === true,
    deviceTypeIdentifier: asString(device.deviceTypeIdentifier) ?? null,
    runtimeIdentifier,
    platform,
    osVersion,
  };
}

function parseRuntimeIdentifier(runtimeIdentifier: string): {
  platform: string | null;
  osVersion: string | null;
} {
  const runtimeName = runtimeIdentifier.replace("com.apple.CoreSimulator.SimRuntime.", "");
  const separator = runtimeName.indexOf("-");
  if (separator < 1) return { platform: null, osVersion: null };

  return {
    platform: runtimeName.slice(0, separator),
    osVersion: runtimeName.slice(separator + 1).replaceAll("-", "."),
  };
}

function hasUdid(device: AppleDevice): boolean {
  return device.udid !== "";
}
