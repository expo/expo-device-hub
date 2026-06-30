/**
 * Where Expo Hub looks for running serve-sim / serve-emu servers.
 *
 *   - iOS streams through the serve-sim **middleware**, which the `serve-sim`
 *     package mounts as a DevTools plugin on the *same dev-server origin* as the
 *     Hub (`/_expo/plugins/serve-sim`). No separate `serve-sim --port 3200`
 *     process is needed — the iOS client discovers the helper via that plugin's
 *     `/api`, lists/starts sims via its `/grid/api`, and a bare helper URL still
 *     works in a reduced video-only mode.
 *   - Android streams through `expo-serve-emu`, which mounts serve-emu the same
 *     way (`/_expo/plugins/expo-serve-emu`) on the Hub's origin. No separate
 *     `serve-emu --port 3300` process is needed — the Android client connects to
 *     that plugin's `/ws` (H.264 video + input) and reads `/api/devices` /
 *     `/api/logcat` under the same prefix.
 *
 * Override at runtime (e.g. from the browser console in the Hub preview, or to
 * point at a standalone `serve-sim --port 3200` / `serve-emu --port 3300`)
 * without a rebuild by setting `window.__EXPO_HUB_ENDPOINTS__ = { ios, android }`.
 */

import { type DevicePlatform } from './types';

/** Same-origin path where the `serve-sim` DevTools plugin is mounted. */
export const SERVE_SIM_PLUGIN_PATH = '/_expo/plugins/serve-sim';

/** Same-origin path where the `expo-serve-emu` DevTools plugin is mounted. */
export const SERVE_EMU_PLUGIN_PATH = '/_expo/plugins/expo-serve-emu';

export const DEFAULT_ENDPOINTS: Record<DevicePlatform, string> = {
  ios: SERVE_SIM_PLUGIN_PATH,
  android: SERVE_EMU_PLUGIN_PATH,
};

declare global {
  interface Window {
    __EXPO_HUB_ENDPOINTS__?: Partial<Record<DevicePlatform, string>>;
  }
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

/** Resolve the base URL for a device, preferring an explicit value, then the
 *  runtime override global, then the built-in default. The iOS default is the
 *  same-origin serve-sim plugin path, qualified with the page origin. */
export function endpointFor(platform: DevicePlatform, explicit?: string | null): string {
  if (explicit) return sameOrigin(explicit);
  const override = typeof window !== 'undefined' ? window.__EXPO_HUB_ENDPOINTS__?.[platform] : undefined;
  return sameOrigin(override ?? DEFAULT_ENDPOINTS[platform]);
}

/**
 * Start (boot if needed + attach a serve-sim helper to) an iOS simulator via the
 * middleware grid. This is the **only** place the Hub boots a sim — it runs on an
 * explicit user action (selecting/adding a device), never automatically. Requires
 * `serve-sim` on PATH on the host (the middleware spawns `serve-sim --detach`).
 */
export async function startIosHelper(udid: string, explicit?: string | null): Promise<void> {
  const base = endpointFor('ios', explicit).replace(/\/$/, '');
  await fetch(`${base}/grid/api/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ udid }),
    // A cold boot can take well over a minute; don't time out early.
    signal: AbortSignal.timeout(190_000),
  });
}
