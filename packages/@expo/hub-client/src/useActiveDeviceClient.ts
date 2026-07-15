import { endpointFor } from './connections';
import { type DeviceClient, type DevicePlatform } from './types';
import { useAndroidDeviceClient } from './useAndroidDevice';
import { useIosDeviceClient } from './useIosDevice';
import { NOOP_DEVICE_CLIENT } from './useNoopDeviceClient';

export interface ActiveDeviceTarget {
  platform: DevicePlatform;
  /** Which running device (udid/serial) to stream. */
  device?: string | null;
}

/**
 * Connect to whichever device is selected and return its live {@link DeviceClient}.
 * With no target selected yet, returns {@link NOOP_DEVICE_CLIENT} so callers can render
 * an idle UI without connecting anything.
 */
export function useActiveDeviceClient(
  target: ActiveDeviceTarget | null,
  hubBase: string,
): DeviceClient {
  const iosActive = target?.platform === 'ios';
  const androidActive = target?.platform === 'android';

  const ios = useIosDeviceClient({
    enabled: iosActive,
    baseUrl: iosActive ? endpointFor('ios', hubBase) : null,
    device: iosActive ? target?.device ?? null : null,
  });
  const android = useAndroidDeviceClient({
    enabled: androidActive,
    baseUrl: androidActive ? endpointFor('android', hubBase) : null,
    device: androidActive ? target?.device ?? null : null,
  });

  if (iosActive) return ios;
  if (androidActive) return android;
  return NOOP_DEVICE_CLIENT;
}
