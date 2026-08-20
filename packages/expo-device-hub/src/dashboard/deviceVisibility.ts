import { type Device, type NewDeviceOptions } from '@expo/hub-components';
import { useEffect } from 'react';

import {
  HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY,
  persistHideUnsupportedDevicesDefault,
  readHideUnsupportedDevices,
  useDashboardStore,
} from './dashboardStore';

export {
  HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY,
  persistHideUnsupportedDevicesDefault,
  readHideUnsupportedDevices,
};

/** Read the browser flag and keep it in sync when another tab changes local storage. */
export function useHideUnsupportedDevices(): boolean {
  const hideUnsupported = useDashboardStore((state) => state.hideUnsupportedDevices);
  const setHideUnsupported = useDashboardStore((state) => state.setHideUnsupportedDevices);

  useEffect(() => {
    persistHideUnsupportedDevicesDefault(window.localStorage);

    const syncFromStorage = (event?: StorageEvent) => {
      if (event && event.key !== null && event.key !== HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY) {
        return;
      }
      setHideUnsupported(readHideUnsupportedDevices(window.localStorage));
    };
    syncFromStorage();

    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY) {
        syncFromStorage(event);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [setHideUnsupported]);

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
