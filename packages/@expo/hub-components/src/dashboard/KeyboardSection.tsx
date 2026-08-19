import { type DeviceClient } from '@expo/hub-client';
import { SidebarActionButton } from './SidebarActionButton';
import { SidebarRow } from './SidebarRow';

/** iOS keyboard connection controls. Browser HID forwarding stays independent. */
export function KeyboardSection({ client }: { client: DeviceClient }) {
  const connected = client.hardwareKeyboardConnected;

  return (
    <section aria-label="Keyboard settings">
      <SidebarRow label="Hardware keyboard" flushTop>
        <SidebarActionButton
          disabled={connected === null}
          onClick={() => client.setHardwareKeyboardConnected(!connected)}>
          Toggle
        </SidebarActionButton>
      </SidebarRow>
      <SidebarRow label="Software keyboard">
        <SidebarActionButton
          disabled={connected === null}
          onClick={() => client.toggleSoftwareKeyboard()}>
          Toggle
        </SidebarActionButton>
      </SidebarRow>
    </section>
  );
}
