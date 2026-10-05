import { type DeviceClient } from '@expo/hub-client';
import { SidebarActionButton } from './SidebarActionButton';
import { SidebarRow } from './SidebarRow';

/** iOS keyboard connection controls. Browser HID forwarding stays independent. */
export function KeyboardSection({ client }: { client: DeviceClient }) {
  const connected = client.keyboard.data?.hardwareConnected;

  return (
    <>
      <SidebarRow label="Hardware keyboard">
        <SidebarActionButton
          disabled={connected === null}
          onClick={() => client.keyboard.setHardwareConnected(!connected)}>
          Toggle
        </SidebarActionButton>
      </SidebarRow>
      <SidebarRow label="Software keyboard">
        <SidebarActionButton
          disabled={connected === null}
          onClick={() => client.keyboard.toggleSoftware()}>
          Toggle
        </SidebarActionButton>
      </SidebarRow>
    </>
  );
}
