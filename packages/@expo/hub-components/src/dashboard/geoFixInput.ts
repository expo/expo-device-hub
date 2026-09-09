import { type DeviceGeoFix } from "@expo/hub-client";

import { type SelectOption } from "../primitives";

export type CoordinateField = "latitude" | "longitude";
export type CoordinateDraft = Record<CoordinateField, string>;

export interface GeoFixInputError {
  field: CoordinateField;
  message: string;
}

const COORDINATE_BOUNDS: Record<CoordinateField, { min: number; max: number; label: string }> = {
  latitude: { min: -90, max: 90, label: "Latitude" },
  longitude: { min: -180, max: 180, label: "Longitude" },
};

export const CUSTOM_PRESET = "custom";

export const LOCATION_PRESETS: ReadonlyArray<{
  value: string;
  label: string;
  fix: DeviceGeoFix;
}> = [
  { value: "apple-park", label: "Apple Park", fix: { latitude: 37.3349, longitude: -122.009 } },
  { value: "london", label: "London", fix: { latitude: 51.5072, longitude: -0.1276 } },
  { value: "tokyo", label: "Tokyo", fix: { latitude: 35.6762, longitude: 139.6503 } },
  { value: "sydney", label: "Sydney", fix: { latitude: -33.8688, longitude: 151.2093 } },
];

export const PRESET_OPTIONS: readonly SelectOption[] = [
  { value: CUSTOM_PRESET, label: "Custom", disabled: true },
  ...LOCATION_PRESETS.map(({ value, label }) => ({ value, label })),
];

/** Plain decimal only, so `Number`'s hex and exponent syntax cannot reach the backend. */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function parseCoordinate(field: CoordinateField, raw: string): number | null {
  const { min, max } = COORDINATE_BOUNDS[field];
  const trimmed = raw.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

function coordinateError(field: CoordinateField): GeoFixInputError {
  const { min, max, label } = COORDINATE_BOUNDS[field];
  return { field, message: `${label} must be a number from ${min} to ${max}` };
}

export type GeoFixInputResult =
  | { ok: true; fix: DeviceGeoFix }
  | { ok: false; error: GeoFixInputError };

export function parseGeoFixInput(draft: CoordinateDraft): GeoFixInputResult {
  const latitude = parseCoordinate("latitude", draft.latitude);
  if (latitude === null) return { ok: false, error: coordinateError("latitude") };
  const longitude = parseCoordinate("longitude", draft.longitude);
  if (longitude === null) return { ok: false, error: coordinateError("longitude") };
  return { ok: true, fix: { latitude, longitude } };
}

/** A `"lat, lng"` paste split into both fields, or null when the text is not a pair. */
export function pastedPair(text: string): CoordinateDraft | null {
  const parts = text.split(",");
  if (parts.length !== 2) return null;
  const latitude = parts[0].trim();
  const longitude = parts[1].trim();
  if (latitude === "" || longitude === "") return null;
  return { latitude, longitude };
}

/** Plain decimal at the 7 places both backends keep, so the box holds text its parser accepts. */
function coordinateText(value: number): string {
  return value.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
}

export function draftFromFix(fix: DeviceGeoFix | null): CoordinateDraft {
  if (!fix) return { latitude: "", longitude: "" };
  return { latitude: coordinateText(fix.latitude), longitude: coordinateText(fix.longitude) };
}

export function formatFix(fix: DeviceGeoFix): string {
  return `${fix.latitude.toFixed(4)}, ${fix.longitude.toFixed(4)}`;
}

export function presetFor(draft: CoordinateDraft): string {
  const parsed = parseGeoFixInput(draft);
  if (!parsed.ok) return CUSTOM_PRESET;
  const match = LOCATION_PRESETS.find(
    ({ fix }) => fix.latitude === parsed.fix.latitude && fix.longitude === parsed.fix.longitude,
  );
  return match ? match.value : CUSTOM_PRESET;
}

export function presetFix(value: string): DeviceGeoFix | null {
  const match = LOCATION_PRESETS.find((preset) => preset.value === value);
  return match ? match.fix : null;
}
