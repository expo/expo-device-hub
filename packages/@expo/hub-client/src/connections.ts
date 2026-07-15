
import { type DevicePlatform } from './types';

const VENDOR_PREFIXES: Record<DevicePlatform, string> = {
  ios: '/vendor/serve-sim',
  android: '/vendor/serve-emu',
};

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

/** Qualify a same-origin path with the current origin so `new URL(..)` against it
 *  keeps the base path (a bare absolute path would be dropped). */
function sameOrigin(path: string): string {
  if (path.startsWith('http')) return path;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return path;
}

/**
 * Resolve the base URL for a device's vendored streaming server.
 *
 * `explicit` (already a full endpoint) wins when provided; otherwise the
 * platform's vendor mount is derived from `hubBase` — the Hub mount itself
 * ('' or '/' = origin root; trailing slashes trimmed) with the vendor prefix
 * appended.
 */
export function endpointFor(
  platform: DevicePlatform,
  hubBase: string,
): string {
  return sameOrigin(`${trimTrailingSlash(hubBase)}${VENDOR_PREFIXES[platform]}`);
}

/**
 * Start (boot if needed + attach a serve-sim helper to) an iOS simulator via the
 * middleware grid. This is the **only** place the Hub boots a sim — it runs on an
 * explicit user action (selecting/adding a device), never automatically. Requires
 * `serve-sim` on PATH on the host (the middleware spawns `serve-sim --detach`).
 */
export async function startIosHelper(udid: string, endpoint: string): Promise<void> {
  const base = trimTrailingSlash(sameOrigin(endpoint));
  await fetch(`${base}/grid/api/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ udid }),
    // A cold boot can take well over a minute; don't time out early.
    signal: AbortSignal.timeout(190_000),
  });
}
