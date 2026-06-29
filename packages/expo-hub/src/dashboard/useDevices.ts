import { useEffect, useState } from 'react';

import { type Device } from '@expo-hub/components';

/**
 * The Expo Hub DevTools plugin server (`src/server/`) exposes the live device
 * list here. Expo CLI mounts the plugin under `/_expo/plugins/expo-hub/*` and
 * strips that prefix before calling our handler, so from the browser the route
 * is the prefixed path below. `?booted=true` narrows the response to running
 * devices; the unfiltered response also includes shut-down ones.
 */
const DEVICES_ENDPOINT = '/_expo/plugins/expo-hub/api/devices';

export type DeviceList = {
  simulators: Device[];
  emulators: Device[];
};

const EMPTY: DeviceList = { simulators: [], emulators: [] };

async function fetchDeviceList(search: string): Promise<DeviceList> {
  const response = await fetch(`${DEVICES_ENDPOINT}${search}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Unexpected ${response.status}`);
  return (await response.json()) as DeviceList;
}

const identity = (list: DeviceList): DeviceList => list;
const onlyUnbooted = (list: DeviceList): DeviceList => ({
  simulators: list.simulators.filter((device) => !device.booted),
  emulators: list.emulators.filter((device) => !device.booted),
});

/**
 * Loads a device list from the plugin server, applying `transform` to the
 * response. Returns the empty list until the fetch resolves, and stays empty if
 * it fails — the endpoint only exists when Hub runs as a DevTools plugin behind
 * `@expo/cli`, so opening the dashboard standalone (e.g. `expo start --web` for
 * design work) falls back to the empty state rather than mocked devices.
 */
function useDeviceList(search: string, transform: (list: DeviceList) => DeviceList): DeviceList {
  const [devices, setDevices] = useState<DeviceList>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await fetchDeviceList(search);
        if (!cancelled) setDevices(transform(data));
      } catch (error) {
        // Keep the empty list — the endpoint is absent outside the plugin.
        console.warn('[expo-hub] No device endpoint, showing empty state:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [search, transform]);

  return devices;
}

/** Booted simulators and emulators/devices — what the sidebar lists. */
export function useDevices(): DeviceList {
  return useDeviceList('?booted=true', identity);
}

/**
 * Shut-down simulators and emulators — the "recent" devices the add-device modal
 * offers. (Booted devices are already in the sidebar, so they're filtered out.)
 */
export function useRecentDevices(): DeviceList {
  return useDeviceList('', onlyUnbooted);
}
