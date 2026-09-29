import { type ComponentType } from 'react';

import {
  type AgentInteraction,
  type DeviceClient,
  type DeviceScreenProps,
  type ScreenSize,
} from '@expo/hub-client';
import { bg, border } from '../primitives';
import { type Device } from './data';
import { DEVICE_TITLE_HEIGHT, DeviceTitle } from './DeviceTitle';
import { type DeviceFrameAssets } from './deviceFrame';
import { PhoneFrame } from './PhoneFrame';
import { ScreenshotToast, useScreenshotToast } from './ScreenshotToast';
import { STREAM_CONTROLS_HEIGHT, StreamControls } from './StreamControls';

/** Space between the title pill and the top of the device frame. */
const TITLE_GAP = 32;
/** Space between the bottom of the device frame and the toolbar. */
const CONTROLS_GAP = 32;

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
  const screenshot = useScreenshotToast(client, device.name);

  return (
    <section
      style={{
        position: 'relative',
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
          padding: `${DEVICE_TITLE_HEIGHT + TITLE_GAP}px 0 ${STREAM_CONTROLS_HEIGHT + CONTROLS_GAP}px`,
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
              left: '50%',
              bottom: `calc(100% + ${TITLE_GAP}px)`,
              display: 'flex',
              justifyContent: 'center',
              width: 'max-content',
              // Bound by the panel, not the frame: `cqw` resolves against the
              // viewport container, so long names keep the panel's width.
              maxWidth: '100cqw',
              transform: 'translateX(-50%)',
            }}>
            <DeviceTitle key={device.id} device={device} status={client.status} recording={client.screenRecording} />
          </div>
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: `calc(100% + ${CONTROLS_GAP}px)`,
              width: 'max-content',
              transform: 'translateX(-50%)',
            }}>
            <StreamControls
              recording={client.screenRecording}
              appearance={client.appearance}
              onToggleAppearance={() =>
                client.setAppearance(client.appearance === 'dark' ? 'light' : 'dark')
              }
              onHome={() => client.pressButton('home')}
              onReload={() => client.reload()}
              onRotate={() => client.rotate()}
              onSave={screenshot.capture}
            />
          </div>
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 16,
          transform: 'translateX(-50%)',
          zIndex: 3,
          width: 'max-content',
          maxWidth: 'calc(100% - 32px)',
        }}>
        <ScreenshotToast
          toast={screenshot.toast}
          onDownloadAgain={screenshot.downloadAgain}
          onPause={screenshot.pause}
          onResume={screenshot.resume}
        />
      </div>
    </section>
  );
}
