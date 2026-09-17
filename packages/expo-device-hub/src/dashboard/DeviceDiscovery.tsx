import { useEffect } from 'react';

import { dashboardPlatformFilter } from '../platform-filter';
import { useDeviceRoute } from './deviceRoute';
import { useDeviceSessionStore } from './deviceSessionStore';
import { useDeviceLists } from './useDevices';

/** Discovery updates selector subscribers, without rendering the dashboard shell. */
export function DeviceDiscovery() {
  const { booted, recent, connectionStatus } = useDeviceLists();
  const { selectedId, selectDevice } = useDeviceRoute();
  const platform = dashboardPlatformFilter();

  useEffect(() => {
    const resolvedId = useDeviceSessionStore.getState().resolveDeviceId(selectedId);
    if (resolvedId !== selectedId) {
      selectDevice(resolvedId, { replace: true });
      return;
    }
    if (!selectedId) {
      const first =
        (platform === 'android' ? undefined : booted.simulators[0]) ??
        (platform === 'ios' ? undefined : booted.emulators[0]);
      if (first) {
        selectDevice(first.id, { replace: true });
        return;
      }
    }
    useDeviceSessionStore.getState().update({ booted, recent, selectedId, platform });
  }, [booted, recent, selectedId, selectDevice, platform]);

  useEffect(() => {
    useDeviceSessionStore.getState().setConnectionStatus(connectionStatus);
  }, [connectionStatus]);

  return null;
}
