import { type DeviceClient } from '@expo/hub-client';
import { Button, radius } from '../primitives';
import { SidebarRow, SidebarSwitch } from './SidebarRow';

/** iOS keyboard connection controls. Browser HID forwarding stays independent. */
export function KeyboardSection({ client }: { client: DeviceClient }) {
  const connected = client.hardwareKeyboardConnected;

  return (
    <section aria-label="Keyboard settings" style={{ padding: '4px 20px 0' }}>
      <SidebarRow label="Hardware keyboard">
        <SidebarSwitch
          checked={connected ?? false}
          disabled={connected === null}
          label="Hardware keyboard"
          onChange={(next) => client.setHardwareKeyboardConnected(next)}
        />
      </SidebarRow>
      <SidebarRow label="Software keyboard">
        <Button
          size="2xs"
          theme="secondary"
          disabled={connected === null}
          onClick={() => client.toggleSoftwareKeyboard()}
          style={{ borderRadius: radius.full, paddingInline: 14 }}>
          Toggle
        </Button>
      </SidebarRow>
    </section>
  );
}
