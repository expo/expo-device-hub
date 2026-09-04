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
import { STREAM_CONTROLS_HEIGHT, StreamControls } from './StreamControls';

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

/** Rendered height of the device title pill (an xs button). */
const TITLE_HEIGHT = 32;
/** Space between the title pill and the top of the device frame. */
const TITLE_GAP = 32;
/** Space between the bottom of the device frame and the toolbar. */
const CONTROLS_GAP = 32;

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
 *
 * The device title sits directly above the frame and the toolbar directly
 * below it, whatever the panel size: the frame viewport reserves their height
 * as padding, and both are anchored to the frame rather than the panel edges.
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
        padding: 40,
        boxSizing: 'border-box',
        backgroundColor: bg.subtle,
        borderLeft: framed ? `1px solid ${border.default}` : 'none',
        borderRight: framed ? `1px solid ${border.default}` : 'none',
        overflow: 'hidden',
      }}>
      <div
        data-testid="device-frame-viewport"
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          width: '100%',
          boxSizing: 'border-box',
          // Container-query units resolve against the content box, so this
          // padding keeps the frame clear of the title above and toolbar below.
          padding: `${TITLE_HEIGHT + TITLE_GAP}px 0 ${STREAM_CONTROLS_HEIGHT + CONTROLS_GAP}px`,
          containerType: 'size',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <div
          data-testid="device-frame-anchor"
          style={{ position: 'relative', display: 'flex', flexShrink: 0 }}>
          <PhoneFrame
            device={device}
            client={client}
            agentInteraction={agentInteraction}
            DeviceScreen={DeviceScreen}
            displayScreen={displayScreen}
            showDeviceFrame={showDeviceFrame}
            deviceFrameAssets={deviceFrameAssets}
          />
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: `calc(100% + ${TITLE_GAP}px)`,
              display: 'flex',
              justifyContent: 'center',
            }}>
            <DeviceTitle key={device.id} device={device} status={client.status} />
          </div>
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `calc(100% + ${CONTROLS_GAP}px)`,
              display: 'flex',
              justifyContent: 'center',
            }}>
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
          </div>
        </div>
      </div>
    </section>
  );
}
