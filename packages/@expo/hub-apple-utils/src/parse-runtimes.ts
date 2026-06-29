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
 * malformed. Never throws.
 */
export function parseRuntimes(json: string): AppleSimulatorRuntime[] {
  const payload = safeJsonParse(json);
  if (!isRecord(payload)) return [];

  const list = payload.runtimes;
  if (!Array.isArray(list)) return [];

  return list.filter(isRecord).map(toRuntime).filter(hasIdentifier);
}

function toRuntime(entry: Record<string, unknown>): AppleSimulatorRuntime {
  return {
    identifier: asString(entry.identifier) ?? "",
    name: asString(entry.name) ?? "",
    version: asString(entry.version) ?? "",
    // simctl spells this `buildversion` (all lowercase).
    buildVersion: asString(entry.buildversion) ?? null,
    platform: asString(entry.platform) ?? null,
    isAvailable: entry.isAvailable === true,
    supportedDeviceTypes: toDeviceTypes(entry.supportedDeviceTypes),
  };
}

function toDeviceTypes(value: unknown): AppleSimulatorDeviceType[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(toDeviceType).filter(hasIdentifier);
}

function toDeviceType(entry: Record<string, unknown>): AppleSimulatorDeviceType {
  return {
    identifier: asString(entry.identifier) ?? "",
    name: asString(entry.name) ?? "",
    productFamily: asString(entry.productFamily) ?? null,
  };
}

function hasIdentifier(entry: { identifier: string }): boolean {
  return entry.identifier !== "";
}
