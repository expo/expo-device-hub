/**
 * Where Expo Hub looks for running serve-sim / serve-emu servers.
 *
 * Defaults match how the bundled CLIs are started for local testing:
 *   - serve-sim (middleware): `serve-sim --port 3200`  → http://localhost:3200
 *     (the iOS client discovers the streaming helper via this server's /api,
 *     same as the serve-sim web client; a bare helper URL also works in a
 *     reduced video-only mode.)
 *   - serve-emu:              `serve-emu --port 3300`   → http://localhost:3300
 *
 * Override at runtime (e.g. from the browser console in the Hub preview) without
 * a rebuild by setting `window.__EXPO_HUB_ENDPOINTS__ = { ios, android }`.
 */

import { type DevicePlatform } from './types';

export const DEFAULT_ENDPOINTS: Record<DevicePlatform, string> = {
  ios: 'http://localhost:3200',
  android: 'http://localhost:3300',
};

declare global {
  interface Window {
    __EXPO_HUB_ENDPOINTS__?: Partial<Record<DevicePlatform, string>>;
  }
}

/** Resolve the base URL for a device, preferring an explicit value, then the
 *  runtime override global, then the built-in default. */
export function endpointFor(platform: DevicePlatform, explicit?: string | null): string {
  if (explicit) return explicit;
  const override = typeof window !== 'undefined' ? window.__EXPO_HUB_ENDPOINTS__?.[platform] : undefined;
  return override ?? DEFAULT_ENDPOINTS[platform];
}
