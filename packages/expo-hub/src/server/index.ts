/**
 * Expo Hub DevTools plugin server entry point.
 *
 * Declared via `expo-module.config.json` (`devtools.serverEntryPoint`). Expo CLI
 * calls this default-exported fetch handler for every request to
 * `/_expo/plugins/expo-hub/*`, with the plugin prefix stripped from the URL,
 * expecting a fetch `Response` back (or `null`/`undefined` to fall through to
 * static serving — this plugin has none, so that becomes a 404).
 *
 * Routes:
 *   GET /api/devices → { simulators, emulators }
 *     - all known simulators and emulators/devices, each with a `booted` flag.
 *   GET /api/devices?booted=true → same shape, narrowed to booted devices only
 *     (what the sidebar shows; the unfiltered list backs the "recent" picker).
 *
 * Authored in TypeScript under `src/server/` and bundled to
 * `dist/server/index.mjs` by `scripts/build-plugin-server.ts` (Bun, single
 * self-contained ESM file).
 */

import { type HubDeviceList, listDevices } from './devices';

const DEVICES_ROUTE = '/api/devices';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export default async function handler(request: Request): Promise<Response | null> {
  const { pathname, searchParams } = new URL(request.url);

  if (pathname === DEVICES_ROUTE) {
    const devices = await listDevices();
    const bootedOnly = searchParams.get('booted') === 'true' || searchParams.get('booted') === '1';
    return jsonResponse(bootedOnly ? filterBooted(devices) : devices);
  }

  // Not one of our routes — returning null lets Expo CLI fall through to static
  // `webpageRoot` serving (this plugin has none, so it becomes a 404).
  return null;
}

/** Narrow a device list to the booted devices in each section. */
function filterBooted(list: HubDeviceList): HubDeviceList {
  return {
    simulators: list.simulators.filter((device) => device.booted),
    emulators: list.emulators.filter((device) => device.booted),
  };
}
