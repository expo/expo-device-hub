import { endpointFor } from './connections';
import { type DeviceClient, type DevicePlatform } from './types';
import { useAndroidDeviceClient } from './useAndroidDevice';
import { useIosDeviceClient } from './useIosDevice';

export interface ActiveDeviceTarget {
  platform: DevicePlatform;
  /** Explicit server base URL; falls back to the platform default endpoint. */
  baseUrl?: string | null;
  /** Which running device (udid/serial) to stream. */
  device?: string | null;
}

/**
 * Connect to whichever device is selected and return its live {@link DeviceClient}.
 *
 * Both platform hooks are always called (hooks can't be conditional), but only
 * the one matching the selected platform is enabled — the other stays inert.
 * This keeps a single shared connection at the Hub's composition root so the
 * stream, logs panel, Home control, and device lists all read from it.
 */
export function useActiveDeviceClient(target: ActiveDeviceTarget | null): DeviceClient {
  const iosActive = target?.platform === 'ios';
  const androidActive = target?.platform === 'android';

  const ios = useIosDeviceClient({
    baseUrl: iosActive ? endpointFor('ios', target?.baseUrl) : null,
    enabled: iosActive,
    device: iosActive ? target?.device ?? null : null,
  });
  const android = useAndroidDeviceClient({
    baseUrl: androidActive ? endpointFor('android', target?.baseUrl) : null,
    enabled: androidActive,
  });

  return androidActive ? android : ios;
}
