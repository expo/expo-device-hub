import { type ComponentType } from 'react';

import { type DeviceClient, type DeviceScreenProps, type ScreenSize } from '@expo/hub-client';
import { bg } from '../primitives';
import { type Device } from './data';
import { PhoneFrame } from './PhoneFrame';
import { StreamControls } from './StreamControls';

/** Trigger a browser download of `blob` under `filename`. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick, once the click has consumed the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Filesystem-safe screenshot name, e.g. `iPhone-16-2026-06-30T12-34-56.png`. */
function screenshotFilename(name: string): string {
  const slug = name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'device';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `${slug}-${stamp}.png`;
}

/** Right panel: the selected device's stream and its controls, full height. */
export function StreamPanel({
  device,
  client,
  DeviceScreen,
  displayScreen,
}: {
  device: Device;
  client: DeviceClient;
  /** Live-stream renderer, injected from `@expo/hub-client` by the consumer. */
  DeviceScreen: ComponentType<DeviceScreenProps>;
  /** Orientation-corrected screen sizer, injected from `@expo/hub-client`. */
  displayScreen: (screen?: ScreenSize | null) => ScreenSize | null;
}) {
  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 40,
        padding: 40,
        boxSizing: 'border-box',
        backgroundColor: bg.subtle,
        overflow: 'hidden',
      }}>
      <PhoneFrame
        platform={device.platform}
        client={client}
        DeviceScreen={DeviceScreen}
        displayScreen={displayScreen}
      />
      <StreamControls
        platform={device.platform}
        physical={device.physical}
        appearance={client.appearance}
        onToggleAppearance={() =>
          client.setAppearance(client.appearance === 'dark' ? 'light' : 'dark')
        }
        onHome={() => client.pressButton('home')}
        onBack={() => client.pressButton('back')}
        onRecents={() => client.pressButton('recents')}
        onSave={async () => {
          const blob = await client.screenshot();
          if (blob) downloadBlob(blob, screenshotFilename(device.name));
        }}
      />
    </section>
  );
}
