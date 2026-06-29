import { type ComponentType } from 'react';

import { type DeviceClient, type DeviceScreenProps, type ScreenSize } from '@expo/hub-client';
import { bg } from '../primitives';
import { type ColorScheme, type Device } from './data';
import { PhoneFrame } from './PhoneFrame';
import { StreamControls } from './StreamControls';

/** Right panel: the selected device's stream and its controls, full height. */
export function StreamPanel({
  device,
  client,
  scheme,
  onToggleTheme,
  DeviceScreen,
  displayScreen,
}: {
  device: Device;
  client: DeviceClient;
  scheme: ColorScheme;
  onToggleTheme: () => void;
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
        scheme={scheme}
        onToggleTheme={onToggleTheme}
        onHome={() => client.pressButton('home')}
        onBack={() => client.pressButton('back')}
        onRecents={() => client.pressButton('recents')}
      />
    </section>
  );
}
