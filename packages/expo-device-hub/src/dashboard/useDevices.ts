import { useEffect, useState } from 'react';

import { type Device } from '@expo/hub-components';

import { basePath } from './basePath';

/**
 * The Expo Hub server (`src/server/`) exposes the live device list here,
 * under whatever mount `basePath()` resolves (the Expo CLI plugin prefix,
 * or wherever the standalone CLI mounts it). `?booted=true` narrows the
 * response to running devices; the unfiltered response also includes
 * shut-down ones.
 */
const devicesEndpoint = () => `${basePath()}/api/devices`;

export type DeviceList = {
  simulators: Device[];
  emulators: Device[];
};

const EMPTY: DeviceList = { simulators: [], emulators: [] };

async function fetchDeviceList(search: string): Promise<DeviceList> {
  const response = await fetch(`${devicesEndpoint()}${search}`, {
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

// Devices boot, shut down, and change orientation outside the dashboard, so we
// re-poll the endpoint on this cadence to keep both lists live.
const POLL_INTERVAL_MS = 500;

/**
 * Loads a device list from the plugin server, applying `transform` to the
 * response, and re-polls every `POLL_INTERVAL_MS` so the list tracks devices
 * booting/shutting down out from under us. Returns the empty list until the
 * first fetch resolves.
 *
 * The endpoint only exists when Hub runs as a DevTools plugin behind
 * `@expo/cli`, so opening the dashboard standalone (e.g. `expo start --web` for
 * design work) falls back to the empty state rather than mocked devices. We
 * stop polling after the first failure so standalone mode logs a single warning
 * instead of spamming the console twice a second.
 */
function useDeviceList(search: string, transform: (list: DeviceList) => DeviceList): DeviceList {
  const [devices, setDevices] = useState<DeviceList>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const data = await fetchDeviceList(search);
        if (cancelled) return;
        setDevices(transform(data));
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (error) {
        // Keep the empty list and stop — the endpoint is absent outside the plugin.
        console.warn('[expo-device-hub] No device endpoint, showing empty state:', error);
      }
    }

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
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
