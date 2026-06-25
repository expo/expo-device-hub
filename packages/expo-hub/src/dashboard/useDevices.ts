import { useEffect, useState } from 'react';

import { emulators as fallbackEmulators, simulators as fallbackSimulators, type Device } from './data';

/**
 * The Expo Hub DevTools plugin server (`src/server/`) exposes the live device
 * list here. Expo CLI mounts the plugin under `/_expo/plugins/expo-hub/*` and
 * strips that prefix before calling our handler, so from the browser the route
 * is the prefixed path below.
 */
const DEVICES_ENDPOINT = '/_expo/plugins/expo-hub/api/devices';

export type DeviceList = {
  simulators: Device[];
  emulators: Device[];
};

/**
 * Loads the device list from the plugin server, replacing the static mock data.
 *
 * The endpoint only exists when Hub runs as a DevTools plugin behind `@expo/cli`
 * (`dist/server/index.mjs`). When the dashboard is opened standalone (e.g.
 * `expo start --web` for design work) the fetch fails and we keep the static
 * `data.ts` lists as a fallback so the UI still renders.
 */
export function useDevices(): DeviceList {
  const [devices, setDevices] = useState<DeviceList>({
    simulators: fallbackSimulators,
    emulators: fallbackEmulators,
  });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(DEVICES_ENDPOINT, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Unexpected ${response.status}`);
        const data = (await response.json()) as DeviceList;
        if (!cancelled) setDevices(data);
      } catch (error) {
        // Keep the fallback list — the endpoint is absent outside the plugin.
        console.warn('[expo-hub] Falling back to static device list:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return devices;
}
