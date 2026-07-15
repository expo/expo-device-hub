import { useEffect, useState } from 'react';

import { type NewDeviceOptions, type Platform } from '@expo/hub-components';

import { basePath } from './basePath';

/**
 * The OS versions + device models offered in the picker's "New simulator" /
 * "New emulator" form. Served (mocked for now) by the Hub server under the
 * `basePath()` mount — the same convention as `useDevices`. Opened without
 * a server (e.g. dev serve with no plugin), the fetch fails and we fall back
 * to empty options, so the form's selects render empty rather than throwing.
 */
const newDeviceOptionsEndpoint = () => `${basePath()}/api/new-device-options`;

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
        const response = await fetch(newDeviceOptionsEndpoint(), {
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
