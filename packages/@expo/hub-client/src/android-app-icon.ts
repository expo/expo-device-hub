import { deviceApiUrl } from "./android-api-url";
import { asRecord } from "./app-permissions";
import { type ForegroundApp } from "./types";

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** Mirrors `APP_ICON_MIME_TYPES` in serve-emu's API contracts. serve-sim's route answers the same shape. */
const APP_ICON_MIME_TYPES = ["image/png", "image/webp", "image/jpeg", "image/gif"];

export function parseAppIconResponse(payload: unknown): string | null {
  const body = asRecord(payload);
  if (!body || body.ok !== true) throw new Error("app icon response is invalid");
  if (body.icon === null) return null;
  const icon = asRecord(body.icon);
  if (!icon) throw new Error("app icon must be an object");
  const { mimeType, data } = icon;
  if (typeof mimeType !== "string" || !APP_ICON_MIME_TYPES.includes(mimeType)) {
    throw new Error("app icon mimeType is invalid");
  }
  if (typeof data !== "string" || !data) throw new Error("app icon data is invalid");
  return `data:${mimeType};base64,${data}`;
}

/**
 * serve-emu reads the label from the APK with `aapt2`, in the same call as the
 * icon. An older serve-emu sends no `label`, which reads as unknown.
 */
export function parseAppLabel(payload: unknown): string | null {
  const label = asRecord(payload)?.label;
  return typeof label === "string" && label ? label : null;
}

/** The {@link ForegroundApp} fields that serve-emu resolves from the installed APK. */
export type AndroidAppDetails = { iconDataUrl: string | null; label: string | null };

export async function fetchAndroidAppDetails(
  baseUrl: string,
  device: string | null,
  packageName: string,
  fetchImpl: FetchImpl = fetch,
): Promise<AndroidAppDetails> {
  const url = new URL(deviceApiUrl(baseUrl, "/api/apps/icon", device));
  url.searchParams.set("packageName", packageName);
  const res = await fetchImpl(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`app details request failed with ${res.status}`);
  const payload: unknown = await res.json();
  return { iconDataUrl: parseAppIconResponse(payload), label: parseAppLabel(payload) };
}

/**
 * Names one installed build of the foreground app. A reinstall with a new
 * version or build can change the label and the icon, so it needs new details.
 */
export function appBuildKey(app: ForegroundApp | null): string | null {
  return app ? JSON.stringify([app.id, app.version ?? null, app.build ?? null]) : null;
}

/**
 * The foreground poll reports neither the icon nor the label, so each poll
 * would otherwise drop the resolved ones, and the details effect would not
 * refetch for the same build.
 */
export function carryForwardAppDetails(
  prev: ForegroundApp | null,
  next: ForegroundApp,
): ForegroundApp {
  if (!prev || appBuildKey(prev) !== appBuildKey(next)) return next;
  const iconDataUrl = next.iconDataUrl || prev.iconDataUrl;
  const label = next.label || prev.label;
  return iconDataUrl === next.iconDataUrl && label === next.label
    ? next
    : { ...next, iconDataUrl, label };
}
