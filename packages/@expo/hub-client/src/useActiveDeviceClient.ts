import { endpointFor } from './connections';
import {
  type DeviceClient,
  type DeviceConnectionOptions,
  type DevicePlatform,
} from './types';
import { useAndroidDeviceClient } from './useAndroidDevice';
import { useIosDeviceClient } from './useIosDevice';
import { NOOP_DEVICE_CLIENT } from './useNoopDeviceClient';

export interface ActiveDeviceTarget {
  platform: DevicePlatform;
  /** Which running device (udid/serial) to stream. */
  device?: string | null;
  /** Explicit consumer-owned stream selection. */
  streamMode: DeviceConnectionOptions['streamMode'];
}

export interface ActiveDeviceClientOptions {
  /** Session token of a Hub started with `--require-token`; see {@link DeviceConnectionOptions.token}. */
  token?: string | null;
}

/**
 * Connect to whichever device is selected and return its live {@link DeviceClient}.
 * With no target selected yet, returns {@link NOOP_DEVICE_CLIENT} so callers can render
 * an idle UI without connecting anything.
 * @deprecated Use DeviceClientProvider with useDeviceClient or useDeviceScreenClient instead.
 */
export function useActiveDeviceClient(
  target: ActiveDeviceTarget | null,
  hubBase: string,
  { token = null }: ActiveDeviceClientOptions = {},
): DeviceClient {
  const iosActive = target?.platform === 'ios';
  const androidActive = target?.platform === 'android';

  const ios = useIosDeviceClient({
    enabled: iosActive,
    baseUrl: iosActive ? endpointFor('ios', hubBase) : null,
    device: iosActive ? target?.device ?? null : null,
    streamMode: target?.streamMode as DeviceConnectionOptions['streamMode'],
    token,
  });
  const android = useAndroidDeviceClient({
    enabled: androidActive,
    baseUrl: androidActive ? endpointFor('android', hubBase) : null,
    device: androidActive ? target?.device ?? null : null,
    streamMode: target?.streamMode as DeviceConnectionOptions['streamMode'],
    token,
  });

  if (iosActive) return ios;
  if (androidActive) return android;
  return NOOP_DEVICE_CLIENT;
}
