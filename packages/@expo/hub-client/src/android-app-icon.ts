import { deviceApiUrl } from './android-api-url';
import { asRecord } from './app-permissions';
import { type ForegroundApp } from './types';

type FetchImpl = typeof fetch;

/** Mirrors `APP_ICON_MIME_TYPES` in serve-emu's API contracts. */
const APP_ICON_MIME_TYPES = ['image/png', 'image/webp', 'image/jpeg', 'image/gif'];

export function parseAndroidAppIcon(payload: unknown): string | null {
  const body = asRecord(payload);
  if (!body || body.ok !== true) throw new Error('app icon response is invalid');
  if (body.icon === null) return null;
  const icon = asRecord(body.icon);
  if (!icon) throw new Error('app icon must be an object');
  const { mimeType, data } = icon;
  if (typeof mimeType !== 'string' || !APP_ICON_MIME_TYPES.includes(mimeType)) {
    throw new Error('app icon mimeType is invalid');
  }
  if (typeof data !== 'string' || !data) throw new Error('app icon data is invalid');
  return `data:${mimeType};base64,${data}`;
}

export async function fetchAndroidAppIcon(
  baseUrl: string,
  device: string | null,
  packageName: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string | null> {
  const url = new URL(deviceApiUrl(baseUrl, '/api/apps/icon', device));
  url.searchParams.set('packageName', packageName);
  const res = await fetchImpl(url.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`app icon request failed with ${res.status}`);
  return parseAndroidAppIcon(await res.json());
}

const iconCache = new Map<string, Promise<string | null>>();

export function getAndroidAppIcon(
  baseUrl: string,
  device: string | null,
  packageName: string,
  fetchImpl?: FetchImpl,
): Promise<string | null> {
  const key = `${baseUrl}:${device ?? ''}:${packageName}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const pending = fetchAndroidAppIcon(baseUrl, device, packageName, fetchImpl).catch(
    (err: unknown) => {
      iconCache.delete(key);
      throw err;
    },
  );
  iconCache.set(key, pending);
  return pending;
}

/**
 * The foreground poll reports no icon, so a changed field would otherwise drop
 * the resolved one and the effect would not refetch for the same package.
 */
export function carryForwardAppIcon(prev: ForegroundApp | null, next: ForegroundApp): ForegroundApp {
  return prev && prev.id === next.id && prev.iconDataUrl && !next.iconDataUrl
    ? { ...next, iconDataUrl: prev.iconDataUrl }
    : next;
}
