import { type ComponentType } from 'react';

import {
  type AgentInteraction,
  type DeviceClient,
  type DeviceScreenProps,
  type ScreenSize,
} from '@expo/hub-client';
import { bg, border } from '../primitives';
import { type Device } from './data';
import { DeviceTitle } from './DeviceTitle';
import { type DeviceFrameAssets } from './deviceFrame';
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

/**
 * Center panel: the selected device's stream and its controls. Rendered as the
 * gray canvas between the white sidebars — `bg.subtle` from edge to edge,
 * separated from each sidebar by the same `border.default` hairline that
 * divides the inspector sections.
 */
export function StreamPanel({
  device,
  client,
  agentInteraction,
  DeviceScreen,
  displayScreen,
  framed = true,
  showDeviceFrame = true,
  deviceFrameAssets,
}: {
  device: Device;
  client: DeviceClient;
  agentInteraction?: AgentInteraction | null;
  /** Live-stream renderer, injected from `@expo/hub-client` by the consumer. */
  DeviceScreen: ComponentType<DeviceScreenProps>;
  /** Orientation-corrected screen sizer, injected from `@expo/hub-client`. */
  displayScreen: (screen?: ScreenSize | null) => ScreenSize | null;
  /**
   * Whether to draw the hairline seams toward the sidebars. Compact layouts
   * disable this so the center view reaches every viewport edge unbroken.
   */
  framed?: boolean;
  /** Viewer-local preference for displaying supported device artwork. */
  showDeviceFrame?: boolean;
  /** Consumer-owned frame artwork keyed by the selected device's frame kind. */
  deviceFrameAssets?: DeviceFrameAssets;
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
        borderLeft: framed ? `1px solid ${border.default}` : 'none',
        borderRight: framed ? `1px solid ${border.default}` : 'none',
        overflow: 'hidden',
      }}>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 20,
        }}>
        <DeviceTitle key={device.id} device={device} status={client.status} />
        <div
          data-testid="device-frame-viewport"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            width: '100%',
            containerType: 'size',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <PhoneFrame
            device={device}
            client={client}
            agentInteraction={agentInteraction}
            DeviceScreen={DeviceScreen}
            displayScreen={displayScreen}
            showDeviceFrame={showDeviceFrame}
            deviceFrameAssets={deviceFrameAssets}
          />
        </div>
      </div>
      <StreamControls
        appearance={client.appearance}
        onToggleAppearance={() =>
          client.setAppearance(client.appearance === 'dark' ? 'light' : 'dark')
        }
        onHome={() => client.pressButton('home')}
        onReload={() => client.reload()}
        onRotate={() => client.rotate()}
        onSave={async () => {
          const blob = await client.screenshot();
          if (blob) downloadBlob(blob, screenshotFilename(device.name));
        }}
      />
    </section>
  );
}
