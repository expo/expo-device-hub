import {
  type ComponentType,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  type AgentInteraction,
  type DeviceClient,
  type DeviceScreenProps,
  type ScreenSize,
  useActiveAgentInteraction,
} from '@expo/hub-client';
import { bg } from '../primitives';
import { AgentDeviceOverlay, type AgentDeviceOverlayHandle } from './AgentDeviceOverlay';
import { type Device } from './data';
import {
  deviceFramePresentation,
  deviceViewportStyle,
  type DeviceFrameAssets,
} from './deviceFrame';
import { deviceScreenClipPath } from './deviceScreenClipPath';

const PRELOADED_FRAME_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: 1,
  height: 1,
  opacity: 0,
  pointerEvents: 'none',
};

// Cap on the device's *short* side (portrait width / landscape height). Sizing
// by the short side keeps the physical phone the same size across rotations:
// in landscape the long side lies horizontally, so what was the portrait
// height becomes the width instead of the frame shrinking into the old width.
const MAX_SHORT_SIDE = 480;

const CONFIG: Record<
  Device['platform'],
  { ratio: number; radiusFraction: number; squircle: boolean }
> = {
  ios: { ratio: 320 / 695, radiusFraction: 55 / 391, squircle: true },
  android: { ratio: 320 / 711, radiusFraction: 10 / 390, squircle: false },
};

/**
 * The selected device's screen. When a {@link DeviceClient} connection is active
 * (a serve-sim/serve-emu server is selected) it renders the live, interactive
 * `DeviceScreen` — injected by the consumer from `@expo/hub-client` so this
 * library stays free of a runtime dependency on it; otherwise it shows an empty
 * idle surface.
 *
 * The phone stays as large as fits (short side capped at {@link MAX_SHORT_SIDE},
 * shrinking to the available height or panel width). Without artwork, the frame
 * adopts the stream's exact aspect ratio. With artwork, the calibrated opening
 * clips a centered, undistorted stream and may crop its edges to prevent leaks.
 */
export function PhoneFrame({
  device,
  client,
  agentInteraction,
  DeviceScreen,
  displayScreen,
  showDeviceFrame = true,
  deviceFrameAssets,
}: {
  device: Device;
  client?: DeviceClient;
  agentInteraction?: AgentInteraction | null;
  /** Live-stream renderer, injected from `@expo/hub-client` by the consumer. */
  DeviceScreen: ComponentType<DeviceScreenProps>;
  /** Orientation-corrected screen sizer, injected from `@expo/hub-client`. */
  displayScreen: (screen?: ScreenSize | null) => ScreenSize | null;
  /** Viewer-local preference. Ignored when the selected model has no frame. */
  showDeviceFrame?: boolean;
  /** Consumer-owned frame artwork so this shared component remains asset-system agnostic. */
  deviceFrameAssets?: DeviceFrameAssets;
}) {
  const [hovered, setHovered] = useState(false);
  const [warningDismissed, setWarningDismissed] = useState(false);
  const [agentInteractionPortalTarget, setAgentInteractionPortalTarget] =
    useState<HTMLDivElement | null>(null);
  const pointerOverlayRef = useRef<AgentDeviceOverlayHandle>(null);
  const { ratio: fallbackRatio, radiusFraction, squircle } = CONFIG[device.platform];

  // Prefer the live screen's aspect ratio once known, so the stream fills the
  // frame 1:1 instead of being stretched to the placeholder's body ratio. Uses
  // the orientation-corrected (display) size so a rotated device shows landscape.
  const display = client ? displayScreen(client.screen) : null;
  const ratio = display && display.height > 0 ? display.width / display.height : fallbackRatio;

  // The container's width is the phone width; `cqw` on the child resolves
  // against it, so the radius is always `radiusFraction` of the rendered width.
  // The pixel cap applies to the short side: in portrait (ratio < 1) it caps the
  // width directly; in landscape it caps the height (width / ratio), so the
  // frame widens on rotation instead of squeezing into the portrait width.
  const wrapperStyle: CSSProperties = {
    ...deviceViewportStyle({ maxShortSide: MAX_SHORT_SIDE, ratio }),
    containerType: 'inline-size',
  };

  // `cqw` resolves against the width, but the radius should stay a fraction of
  // the *short* side so the corners look the same in portrait and landscape.
  const radiusCqw = (radiusFraction / Math.max(ratio, 1)) * 100;
  const borderRadius = `${radiusCqw.toFixed(3)}cqw`;
  const live = client && client.status !== 'idle';
  const activeAgentInteraction = useActiveAgentInteraction(agentInteraction);
  const overlayVisible = !!activeAgentInteraction && hovered;
  const warningVisible = overlayVisible && !warningDismissed;

  useEffect(() => {
    if (!activeAgentInteraction) setWarningDismissed(false);
  }, [activeAgentInteraction]);

  const positionPointerCallout = (event: ReactPointerEvent<HTMLDivElement>) => {
    const frame = event.currentTarget.getBoundingClientRect();
    pointerOverlayRef.current?.position({
      clientX: event.clientX,
      clientY: event.clientY,
      frameLeft: frame.left,
      frameTop: frame.top,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
  };

  const deviceSurface = live ? (
    <DeviceScreen
      client={client}
      agentInteraction={activeAgentInteraction}
      agentInteractionPortalTarget={agentInteractionPortalTarget}
    />
  ) : (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: bg.element }} />
  );
  const frameAsset =
    showDeviceFrame && device.deviceFrame ? deviceFrameAssets?.[device.deviceFrame] : undefined;
  const framed = frameAsset
    ? deviceFramePresentation({
        asset: frameAsset,
        orientation: client?.screen?.orientation,
        displayRatio: ratio,
        maxScreenShortSide: MAX_SHORT_SIDE,
      })
    : null;
  const screenStyle: CSSProperties = framed
    ? { ...framed.screenStyle, backgroundColor: bg.element }
    : {
        position: 'absolute',
        inset: 0,
        // Keep the stream clipped to the device screen while pointer notices
        // can use the nearby panel space outside the physical frame.
        clipPath: deviceScreenClipPath(radiusCqw, squircle),
      };
  const agentInteractionOverlayStyle: CSSProperties = {
    ...screenStyle,
    zIndex: 3,
    overflow: 'visible',
    borderRadius: undefined,
    backgroundColor: 'transparent',
    clipPath: undefined,
    pointerEvents: 'none',
  };

  return (
    <div
      data-testid="device-screen-frame"
      data-device-frame-kind={framed ? device.deviceFrame : 'none'}
      data-agent-active={activeAgentInteraction ? 'true' : 'false'}
      style={{
        ...(framed ? framed.frameStyle : { ...wrapperStyle, borderRadius }),
        cursor: activeAgentInteraction ? 'none' : undefined,
      }}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') {
          positionPointerCallout(event);
          setHovered(true);
        }
      }}
      onPointerMove={(event) => {
        if (event.pointerType !== 'touch' && activeAgentInteraction) positionPointerCallout(event);
      }}
      onPointerDown={(event) => {
        if (!activeAgentInteraction) return;
        if (event.pointerType !== 'touch') positionPointerCallout(event);
        setWarningDismissed(true);
      }}
      onPointerLeave={() => setHovered(false)}
    >
      <div
        data-testid="device-screen-clip"
        data-device-frame-screen={framed ? 'true' : undefined}
        style={screenStyle}
      >
        <div
          data-testid="device-frame-stream-cover"
          style={framed ? framed.streamStyle : { position: 'absolute', inset: 0 }}
        >
          {deviceSurface}
        </div>
      </div>
      {deviceFrameAssets
        ? (Object.keys(deviceFrameAssets) as (keyof DeviceFrameAssets)[]).map((kind) => {
            const asset = deviceFrameAssets[kind];
            const active = !!framed && device.deviceFrame === kind;

            return (
              <img
                key={kind}
                data-testid={active ? 'device-frame-artwork' : undefined}
                data-device-frame-artwork-kind={kind}
                src={asset.src}
                alt=""
                aria-hidden="true"
                draggable={false}
                decoding="async"
                loading="eager"
                style={active ? framed.artworkStyle : PRELOADED_FRAME_STYLE}
              />
            );
          })
        : null}
      <div
        aria-hidden="true"
        data-testid="agent-interaction-overlay"
        style={agentInteractionOverlayStyle}
      >
        <div
          data-testid="agent-interaction-stream-alignment"
          style={framed ? framed.streamStyle : { position: 'absolute', inset: 0 }}
        >
          <div
            ref={setAgentInteractionPortalTarget}
            data-testid="agent-interaction-portal-target"
            style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}
          />
        </div>
      </div>
      <AgentDeviceOverlay
        ref={pointerOverlayRef}
        visible={overlayVisible}
        warningVisible={warningVisible}
      />
    </div>
  );
}
