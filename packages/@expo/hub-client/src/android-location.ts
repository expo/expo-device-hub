import { type DeviceGeoFix } from "./types";
import { type DeviceLocationRead } from "./useDeviceLocation";

const UNSUPPORTED: DeviceLocationRead = { supported: false, location: null };

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

export async function readAndroidLocation(
  fetchImpl: typeof fetch,
  url: string,
): Promise<DeviceLocationRead> {
  try {
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response.ok) return UNSUPPORTED;
    const payload = asRecord(await response.json());
    if (!payload || payload.emulator !== true) return UNSUPPORTED;
    return { supported: true, location: parseAndroidFix(payload.location) };
  } catch {
    return UNSUPPORTED;
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
