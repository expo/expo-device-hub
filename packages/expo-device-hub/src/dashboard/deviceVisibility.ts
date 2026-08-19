import { type Device, type NewDeviceOptions } from '@expo/hub-components';
import { useEffect, useState } from 'react';

export const HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY =
  'expo-device-hub.hideUnsupportedDevices';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Missing or malformed values use the safe default: hide untested devices. */
export function readHideUnsupportedDevices(storage: ReadableStorage): boolean {
  try {
    return storage.getItem(HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** Persist the default so the browser flag is visible and easy to override. */
export function persistHideUnsupportedDevicesDefault(storage: WritableStorage): void {
  try {
    if (storage.getItem(HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY) === null) {
      storage.setItem(HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY, 'true');
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts; retain the in-memory default.
  }
}

/** Read the browser flag and keep it in sync when another tab changes local storage. */
export function useHideUnsupportedDevices(): boolean {
  const [hideUnsupported, setHideUnsupported] = useState(() =>
    readHideUnsupportedDevices(window.localStorage)
  );

  useEffect(() => {
    persistHideUnsupportedDevicesDefault(window.localStorage);

    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY) {
        setHideUnsupported(readHideUnsupportedDevices(window.localStorage));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return hideUnsupported;
}

/** Apply the creation/recents policy without ever affecting the booted sidebar lists. */
export function visibleDevices(devices: Device[], hideUnsupported: boolean): Device[] {
  return hideUnsupported ? devices.filter((device) => device.supported) : devices;
}

/** Remove untested models and any runtime left without a creatable model. */
export function visibleNewDeviceOptions(
  options: NewDeviceOptions,
  hideUnsupported: boolean
): NewDeviceOptions {
  if (!hideUnsupported) return options;

  return {
    runtimes: options.runtimes
      .map((runtime) => ({
        ...runtime,
        models: runtime.models.filter((model) => model.supported),
      }))
      .filter((runtime) => runtime.models.length > 0),
  };
}
