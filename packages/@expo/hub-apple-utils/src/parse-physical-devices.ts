import { type AppleUtilsResult, result } from "./errors";
import { asString, isRecord, safeJsonParse } from "./json";
import type { ApplePhysicalDevice } from "./types";

const STREAMABLE_PLATFORMS = new Set(["iOS", "iPadOS"]);

// @ref LLP 0027#listing — serve-sim keeps a copy of these rules; both give the same reasons in the same order
/**
 * Parse the JSON file that `xcrun devicectl list devices --json-output <file>` writes.
 *
 * Keeps real hardware (`reality: "physical"`) on iOS or iPadOS that is paired with this Mac and
 * has Developer Mode on. A phone whose tunnel is disconnected is kept, because opening it
 * connects. Simulators, which devicectl lists too, are dropped. Reads the `properties`
 * dictionary first and falls back to the deprecated `hardwareProperties`, `deviceProperties` and
 * `connectionProperties`. Malformed JSON is returned in `error`. Never throws.
 */
export function parsePhysicalDevicesJson(json: string): AppleUtilsResult<ApplePhysicalDevice[]> {
  const parsed = safeJsonParse(json);
  if (parsed.error) return result([], parsed.error);
  if (!isRecord(parsed.value) || !isRecord(parsed.value.result)) return result([]);

  const devices = parsed.value.result.devices;
  if (!Array.isArray(devices)) return result([]);

  return result(
    devices
      .filter(isRecord)
      .map(toPhysicalDevice)
      .filter((device): device is ApplePhysicalDevice => device !== null),
  );
}

function toPhysicalDevice(device: Record<string, unknown>): ApplePhysicalDevice | null {
  const properties = record(device.properties);
  const hardware = { ...record(device.hardwareProperties), ...record(properties.hardware) };
  const legacyState = record(device.deviceProperties);
  const state = { ...legacyState, ...record(properties.state) };
  const connection = { ...record(device.connectionProperties), ...record(properties.connection) };

  const udid = asString(hardware.udid);
  const platform = asString(hardware.platform);
  if (
    !udid ||
    hardware.reality !== "physical" ||
    !platform ||
    !STREAMABLE_PLATFORMS.has(platform) ||
    connection.pairingState !== "paired" ||
    !developerModeEnabled(state.developerModeStatus)
  ) {
    return null;
  }

  return {
    udid,
    identifier: asString(device.identifier) ?? udid,
    name: asString(state.name) ?? asString(hardware.marketingName) ?? "iPhone",
    marketingName: asString(hardware.marketingName) ?? null,
    productType: asString(hardware.productType) ?? null,
    deviceType: asString(hardware.deviceType) ?? null,
    platform,
    osVersion:
      asString(record(record(properties.software).osVersionNumber).stringValue) ??
      asString(legacyState.osVersionNumber) ??
      null,
    transportType: asString(connection.transportType) ?? null,
    connected: (connection.state ?? connection.tunnelState) === "connected",
  };
}

/** `"enabled"` in the deprecated field, `{ enabled: { mode } }` in `properties`. */
function developerModeEnabled(status: unknown): boolean {
  return status === "enabled" || (isRecord(status) && "enabled" in status);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
