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
 *     - simulators: booted iOS simulators via `@expo-hub/apple-utils`
 *     - emulators:  booted Android devices (emulators + physical) via `@expo-hub/android-utils`
 *
 * Authored in TypeScript under `src/server/` and bundled to
 * `dist/server/index.mjs` by `scripts/build-plugin-server.ts` (Bun, single
 * self-contained ESM file).
 */

import { listDevices } from './devices';

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
  const { pathname } = new URL(request.url);

  if (pathname === DEVICES_ROUTE) {
    return jsonResponse(await listDevices());
  }

  // Not one of our routes — returning null lets Expo CLI fall through to static
  // `webpageRoot` serving (this plugin has none, so it becomes a 404).
  return null;
}
