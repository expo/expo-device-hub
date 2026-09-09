import { type DeviceGeoFix } from "./types";
import { type DeviceLocationRead } from "./useDeviceLocation";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseAndroidFix(value: unknown): DeviceGeoFix | null {
  const data = asRecord(value);
  if (!data) return null;
  const latitude = finiteNumber(data.latitude);
  const longitude = finiteNumber(data.longitude);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

/** GET /api/location. Null when the read could not be answered, so the caller can retry. */
export async function readAndroidLocation(
  fetchImpl: typeof fetch,
  url: string,
): Promise<DeviceLocationRead | null> {
  try {
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response.ok) return null;
    const payload = asRecord(await response.json());
    if (!payload || typeof payload.emulator !== "boolean") return null;
    if (!payload.emulator) return { supported: false, location: null };
    return { supported: true, location: parseAndroidFix(payload.location) };
  } catch {
    return null;
  }
}

export async function writeAndroidLocation(
  fetchImpl: typeof fetch,
  url: string,
  fix: DeviceGeoFix,
): Promise<DeviceGeoFix> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fix),
  });
  const payload: unknown = await response.json().catch(() => null);
  const data = asRecord(payload);
  if (!response.ok || data?.ok !== true) {
    const error = data?.error;
    throw new Error(
      typeof error === "string" ? error : `Location update failed (${response.status})`,
    );
  }
  return parseAndroidFix(data.location) ?? fix;
}
