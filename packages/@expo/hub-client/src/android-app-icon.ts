import { deviceApiUrl } from './android-api-url';
import { type ForegroundApp } from './types';

type FetchImpl = typeof fetch;

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
  const data = (await res.json()) as {
    ok?: boolean;
    icon?: { mimeType?: string; data?: string } | null;
  };
  const icon = data.ok ? data.icon : null;
  if (!icon?.mimeType || !icon.data) return null;
  return `data:${icon.mimeType};base64,${icon.data}`;
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
