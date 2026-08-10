import { type DeviceClient } from '@expo/hub-client';
import { Button, text, textSize } from '../primitives';

/** iOS keyboard connection controls. Browser HID forwarding stays independent. */
export function KeyboardSection({ client }: { client: DeviceClient }) {
  const connected = client.hardwareKeyboardConnected;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>Keyboard</span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          minHeight: 44,
        }}>
        <span style={{ ...textSize.xs, color: text.secondary }}>Hardware keyboard</span>
        <Button
          size="xs"
          theme="secondary"
          disabled={connected === null}
          onClick={() => client.setHardwareKeyboardConnected(!connected)}>
          {connected ? 'Disconnect' : 'Connect'}
        </Button>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          minHeight: 44,
        }}>
        <span style={{ ...textSize.xs, color: text.secondary }}>Software keyboard</span>
        <Button
          size="xs"
          theme="secondary"
          disabled={connected === null}
          onClick={() => client.toggleSoftwareKeyboard()}>
          Toggle
        </Button>
      </div>
    </section>
  );
}
