import { DeviceClientProvider, useDeviceClientSelector } from '../DeviceClientProvider';
import type { DeviceClient, DeviceConnectionOptions, DevicePlatform } from '../types';

const selectClient = (client: DeviceClient) => client;

function Probe({ onClient }: { onClient(client: DeviceClient): void }) {
  onClient(useDeviceClientSelector(selectClient));
  return null;
}

/**
 * Connect through the public provider and hand each published client to the
 * test. A render happens only when the provider publishes a new client object.
 */
export function ClientProbe({
  platform,
  options,
  onClient,
}: {
  platform: DevicePlatform;
  options: DeviceConnectionOptions;
  onClient(client: DeviceClient): void;
}) {
  return (
    <DeviceClientProvider platform={platform} options={options}>
      <Probe onClient={onClient} />
    </DeviceClientProvider>
  );
}
