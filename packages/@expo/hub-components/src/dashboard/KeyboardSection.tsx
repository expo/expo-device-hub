import { type DeviceClient } from '@expo/hub-client';
import { SidebarActionButton } from './SidebarActionButton';
import { SidebarRow } from './SidebarRow';

/** iOS keyboard connection controls. Browser HID forwarding stays independent. */
export function KeyboardSection({ client }: { client: DeviceClient }) {
  const { keyboard } = client;
  const connected = keyboard.data?.hardwareConnected;
  // Both controls act on a known keyboard state; feature data is undefined until read.
  const ready = keyboard.status === 'ready' && connected !== undefined;
  const writing = keyboard.writes.pending.has('hardwareConnected');

  return (
    <>
      <SidebarRow
        label="Hardware keyboard"
        description={keyboard.writes.errors.get('hardwareConnected')?.message}>
        <SidebarActionButton
          disabled={!ready || writing}
          onClick={() => void keyboard.setHardwareConnected(!connected)}>
          Toggle
        </SidebarActionButton>
      </SidebarRow>
      <SidebarRow label="Software keyboard">
        <SidebarActionButton disabled={!ready} onClick={() => keyboard.toggleSoftware()}>
          Toggle
        </SidebarActionButton>
      </SidebarRow>
    </>
  );
}
