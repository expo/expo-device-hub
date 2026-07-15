/**
 * Expo Hub DevTools plugin server entry point. Expo CLI calls the default export for
 * `/_expo/plugins/expo-device-hub/*` (prefix stripped) and mounts each `webSocketHandlers`
 * route at `/_expo/plugins/expo-device-hub/<route>`. Bundled to `dist/server/index.mjs`.
 *
 * Any host can mount this the same way under a different prefix (strip the prefix, then
 * call the handler) by setting EXPO_DEVICE_HUB_BASE_PATH to that prefix ('' = origin
 * root) before importing — serve-sim bakes the mount into the URLs it hands the browser,
 * so it must be known server-side (see ./serve-sim.ts).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { bootHubDevice, parseDeviceAction, removeHubDevice, shutdownHubDevice } from './device-actions';
import { type HubDeviceList, listDevices } from './devices';
import { MOUNT_PATH } from './mount';
import { EMU_PREFIX, emuWebSocketHandler, handleEmuRequest } from './serve-emu';
import { SIM_PREFIX, handleSimRequest, simWebSocketHandler } from './serve-sim';
import { MOCK_NEW_DEVICE_OPTIONS } from './sim-options';

const DEVICES_ROUTE = '/api/devices';
const SHUTDOWN_DEVICE_ROUTE = '/api/devices/shutdown';
const REMOVE_DEVICE_ROUTE = '/api/devices/remove';
const BOOT_DEVICE_ROUTE = '/api/devices/boot';
const NEW_DEVICE_OPTIONS_ROUTE = '/api/new-device-options';

// The exported dashboard shell (dist/client/index.html, a sibling of the
// dist/server bundle this file becomes). Its asset URLs are relative and its
// `<base href="{{mount}}/">` carries a placeholder, so it must be served
// through this handler — which substitutes the actual mount — rather than as a
// plain static file. Read lazily and cached: the file is absent until
// `build:web` has run (e.g. dev serve via modules/expo-device-hub), in which
// case we fall through to the host's own static serving / 404.
let clientIndexHtml: string | null = null;
async function serveClientIndexHtml(): Promise<Response | null> {
  if (clientIndexHtml === null) {
    try {
      clientIndexHtml = await readFile(
        fileURLToPath(new URL('../client/index.html', import.meta.url)),
        'utf-8',
      );
    } catch {
      return null;
    }
  }
  return new Response(clientIndexHtml.replaceAll('{{mount}}', MOUNT_PATH), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export default async function handler(request: Request): Promise<Response | null> {
  const { pathname, searchParams } = new URL(request.url);

  if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveClientIndexHtml();
  }

  if (pathname === SIM_PREFIX || pathname.startsWith(`${SIM_PREFIX}/`)) {
    return handleSimRequest(request);
  }
  if (pathname === EMU_PREFIX || pathname.startsWith(`${EMU_PREFIX}/`)) {
    return handleEmuRequest(request);
  }

  if (pathname === DEVICES_ROUTE) {
    const devices = await listDevices();
    const bootedOnly = searchParams.get('booted') === 'true' || searchParams.get('booted') === '1';
    return jsonResponse(bootedOnly ? filterBooted(devices) : devices);
  }

  if (pathname === SHUTDOWN_DEVICE_ROUTE || pathname === REMOVE_DEVICE_ROUTE) {
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    const action = await parseDeviceAction(request);
    if (!action) {
      return jsonResponse({ ok: false, error: 'Expected { platform, id, name } JSON body' }, 400);
    }

    try {
      const ok =
        pathname === SHUTDOWN_DEVICE_ROUTE
          ? await shutdownHubDevice(action)
          : await removeHubDevice(action);
      return jsonResponse({ ok });
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error) }, 500);
    }
  }

  if (pathname === BOOT_DEVICE_ROUTE) {
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    const action = await parseDeviceAction(request);
    if (!action) {
      return jsonResponse({ ok: false, error: 'Expected { platform, id, name } JSON body' }, 400);
    }

    try {
      return jsonResponse(await bootHubDevice(action));
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error) }, 500);
    }
  }

  if (pathname === NEW_DEVICE_OPTIONS_ROUTE) {
    return jsonResponse(MOCK_NEW_DEVICE_OPTIONS);
  }

  return null;
}

export const webSocketHandlers = {
  [`${SIM_PREFIX}/exec-ws`]: simWebSocketHandler,
  [`${SIM_PREFIX}/helper/ws`]: simWebSocketHandler,
  [`${EMU_PREFIX}/ws`]: emuWebSocketHandler,
};

function filterBooted(list: HubDeviceList): HubDeviceList {
  return {
    simulators: list.simulators.filter((device) => device.booted),
    emulators: list.emulators.filter((device) => device.booted),
  };
}
