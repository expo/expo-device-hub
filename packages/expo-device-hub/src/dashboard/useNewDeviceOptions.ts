import { useEffect, useState } from 'react';

import { type NewDeviceOptions, type Platform } from '@expo/hub-components';

/**
 * The OS versions + device models offered in the picker's "New simulator" /
 * "New emulator" form. Served (mocked for now) by the Hub DevTools plugin at the
 * prefixed route below — the same plugin-mount convention as `useDevices`. Opened
 * standalone (no plugin), the fetch fails and we fall back to empty options, so
 * the form's selects render empty rather than throwing.
 */
const NEW_DEVICE_OPTIONS_ENDPOINT = '/_expo/plugins/expo-device-hub/api/new-device-options';

export type NewDeviceOptionsByPlatform = Record<Platform, NewDeviceOptions>;

const EMPTY_OPTIONS: NewDeviceOptions = { osVersions: [], models: [] };
const EMPTY: NewDeviceOptionsByPlatform = { ios: EMPTY_OPTIONS, android: EMPTY_OPTIONS };

/**
 * Loads the new-device options once. Returns empty options until the fetch
 * resolves, and stays empty if it fails (e.g. running the dashboard outside the
 * plugin), matching how `useDevices` degrades.
 */
export function useNewDeviceOptions(): NewDeviceOptionsByPlatform {
  const [options, setOptions] = useState<NewDeviceOptionsByPlatform>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(NEW_DEVICE_OPTIONS_ENDPOINT, {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`Unexpected ${response.status}`);
        const data = (await response.json()) as NewDeviceOptionsByPlatform;
        if (!cancelled) setOptions(data);
      } catch (error) {
        console.warn('[expo-device-hub] No new-device-options endpoint, using empty options:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return options;
}
