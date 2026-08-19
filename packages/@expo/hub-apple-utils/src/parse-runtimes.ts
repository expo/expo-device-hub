import { type AppleUtilsResult, result } from "./errors";
import { asString, isRecord, safeJsonParse } from "./json";
import type { AppleSimulatorDeviceType, AppleSimulatorRuntime } from "./types";

/**
 * Parse the JSON from `xcrun simctl list runtimes --json`.
 *
 * Returns one entry per `runtimes[]` element, dropping any without an
 * `identifier` (the value `simctl create` needs). Each runtime's
 * `supportedDeviceTypes` are parsed too, so a device type can be paired with the
 * runtime that lists it — a guaranteed-valid `simctl create` combination. All
 * platforms (iOS, tvOS, watchOS, …) are kept — filter by `platform` /
 * `isAvailable` as needed. Returns an empty array when the payload is missing or
 * malformed. Malformed JSON is returned in `error`. Never throws.
 */
export function parseRuntimes(json: string): AppleUtilsResult<AppleSimulatorRuntime[]> {
  const parsed = safeJsonParse(json);
  if (parsed.error) return result([], parsed.error);
  if (!isRecord(parsed.value)) return result([]);

  const list = parsed.value.runtimes;
  if (!Array.isArray(list)) return result([]);

  return result(list.filter(isRecord).map(toRuntime).filter(hasIdentifier));
}

function toRuntime(entry: Record<string, unknown>): AppleSimulatorRuntime {
  const platform = asString(entry.platform) ?? null;

  return {
    identifier: asString(entry.identifier) ?? "",
    name: asString(entry.name) ?? "",
    version: asString(entry.version) ?? "",
    // simctl spells this `buildversion` (all lowercase).
    buildVersion: asString(entry.buildversion) ?? null,
    platform,
    isAvailable: entry.isAvailable === true,
    supportedDeviceTypes: toDeviceTypes(entry.supportedDeviceTypes, platform === "iOS"),
  };
}

function toDeviceTypes(
  value: unknown,
  warnForMissingProductFamily: boolean,
): AppleSimulatorDeviceType[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => toDeviceType(entry, warnForMissingProductFamily))
    .filter(hasIdentifier);
}

function toDeviceType(
  entry: Record<string, unknown>,
  warnForMissingProductFamily: boolean,
): AppleSimulatorDeviceType {
  const identifier = asString(entry.identifier) ?? "";
  const name = asString(entry.name) ?? "";
  const productFamily = asString(entry.productFamily) || null;

  if (warnForMissingProductFamily && productFamily === null) {
    console.warn(
      `[apple-utils] Failed to parse productFamily for iOS device type: ${identifier || name || "unknown"}`,
    );
  }

  return {
    identifier,
    name,
    productFamily,
  };
}

function hasIdentifier(entry: { identifier: string }): boolean {
  return entry.identifier !== "";
}
