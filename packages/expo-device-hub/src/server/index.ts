/**
 * Expo Hub DevTools plugin server entry point. Expo CLI calls the default export for
 * `/_expo/plugins/expo-device-hub/*` (prefix stripped) and mounts each `webSocketHandlers`
 * route at `/_expo/plugins/expo-device-hub/<route>`. Bundled to `dist/server/index.mjs`.
 */

import { type HubDeviceList, listDevices } from './devices';
import { EMU_PREFIX, emuWebSocketHandler, handleEmuRequest } from './serve-emu';
import { SIM_PREFIX, handleSimRequest, simExecWebSocketHandler } from './serve-sim';
import { MOCK_NEW_DEVICE_OPTIONS } from './sim-options';

const DEVICES_ROUTE = '/api/devices';
const NEW_DEVICE_OPTIONS_ROUTE = '/api/new-device-options';

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

  if (pathname === NEW_DEVICE_OPTIONS_ROUTE) {
    return jsonResponse(MOCK_NEW_DEVICE_OPTIONS);
  }

  return null;
}

export const webSocketHandlers = {
  [`${SIM_PREFIX}/exec-ws`]: simExecWebSocketHandler,
  [`${EMU_PREFIX}/ws`]: emuWebSocketHandler,
};

function filterBooted(list: HubDeviceList): HubDeviceList {
  return {
    simulators: list.simulators.filter((device) => device.booted),
    emulators: list.emulators.filter((device) => device.booted),
  };
}
