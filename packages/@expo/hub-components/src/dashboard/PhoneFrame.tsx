import { type ComponentType, type CSSProperties, useState } from 'react';

import {
  type AgentInteraction,
  type DeviceClient,
  type DeviceScreenProps,
  type FoldableDeviceScreenProps,
  type ScreenSize,
} from '@expo/hub-client';
import { bg } from '../primitives';
import { AgentDeviceOverlay } from './AgentDeviceOverlay';
import { type Device } from './data';
import {
  deviceFramePresentation,
  deviceViewportStyle,
  type DeviceFrameAssets,
} from './deviceFrame';
import {
  deviceScreenClipPath,
  deviceScreenCornersClipPath,
  type ScreenCornerRadiiCqw,
} from './deviceScreenClipPath';

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

// The iPhone Duo's 3D stage keeps one square footprint as the device folds and
// changes active displays (serve-sim's fixed 1:1 stage). Resizing it with each
// native screen configuration would animate on top of the hinge motion.
const DUO_STAGE_WIDTH = 580;

/** Viewer-local 3D options the consumer passes through to `FoldableDeviceScreen`. */
export type PhoneFrameFoldPreview = Pick<
  FoldableDeviceScreenProps,
  'cacheScreenOnFold' | 'sizeMode' | 'onUnavailable'
>;

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
  FoldableDeviceScreen,
  foldPreview,
  displayScreen,
  showDeviceFrame = true,
  deviceFrameAssets,
}: {
  device: Device;
  client?: DeviceClient;
  agentInteraction?: AgentInteraction | null;
  /** Live-stream renderer, injected from `@expo/hub-client` by the consumer. */
  DeviceScreen: ComponentType<DeviceScreenProps>;
  /** iPhone Duo 3D renderer, injected from `@expo/hub-client`; without it the Duo stays flat. */
  FoldableDeviceScreen?: ComponentType<FoldableDeviceScreenProps>;
  foldPreview?: PhoneFrameFoldPreview;
  /** Orientation-corrected screen sizer, injected from `@expo/hub-client`. */
  displayScreen: (screen?: ScreenSize | null) => ScreenSize | null;
  /** Viewer-local preference. Ignored when the selected model has no frame. */
  showDeviceFrame?: boolean;
  /** Consumer-owned frame artwork so this shared component remains asset-system agnostic. */
  deviceFrameAssets?: DeviceFrameAssets;
}) {
  const [hovered, setHovered] = useState(false);
  const [dismissedInteractionId, setDismissedInteractionId] = useState<string | null>(null);
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
    ...deviceViewportStyle({
      // Match serve-sim's 320px portrait / 620px landscape screen widths.
      maxShortSide: client?.hinge ? (ratio > 1 ? 620 / ratio : 320) : MAX_SHORT_SIDE,
      ratio,
    }),
    ...(client?.hinge ? { transition: 'width 250ms ease, aspect-ratio 250ms ease' } : {}),
    containerType: 'inline-size',
  };

  // `cqw` resolves against the width, but the radius should stay a fraction of
  // the *short* side so the corners look the same in portrait and landscape.
  const radiusCqw = (radiusFraction / Math.max(ratio, 1)) * 100;
  // A display that describes its own glass, like the iPhone Duo's cover and
  // inner panel, is clipped to those corners: what the 3D model shows head-on,
  // without the frame. The client already turned them with the device.
  const displayCorners: ScreenCornerRadiiCqw | null = client?.displayCorners
    ? {
        topLeft: client.displayCorners.topLeft * 100,
        topRight: client.displayCorners.topRight * 100,
        bottomRight: client.displayCorners.bottomRight * 100,
        bottomLeft: client.displayCorners.bottomLeft * 100,
      }
    : null;
  const borderRadius = displayCorners
    ? [
        displayCorners.topLeft,
        displayCorners.topRight,
        displayCorners.bottomRight,
        displayCorners.bottomLeft,
      ]
        .map((corner) => `${corner.toFixed(3)}cqw`)
        .join(' ')
    : `${radiusCqw.toFixed(3)}cqw`;
  const live = client && client.status !== 'idle';
  const overlayVisible =
    !!agentInteraction && hovered && dismissedInteractionId !== agentInteraction.id;

  const deviceSurface = live ? (
    <DeviceScreen client={client} agentInteraction={agentInteraction} />
  ) : (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: bg.element }} />
  );
  const takeoverOverlay = (
    <div
      data-testid="agent-device-overlay-clip"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        pointerEvents: overlayVisible ? 'auto' : 'none',
      }}>
      <AgentDeviceOverlay
        visible={overlayVisible}
        onTakeOver={() => setDismissedInteractionId(agentInteraction?.id ?? null)}
      />
    </div>
  );

  // The folding model draws its own device, so neither frame artwork nor the
  // screen clip applies; the agent overlay still covers the stage.
  if (live && client.hinge?.modelActive && FoldableDeviceScreen) {
    return (
      <div
        data-testid="device-screen-frame"
        data-device-frame-kind="duo-model"
        data-agent-active={agentInteraction ? 'true' : 'false'}
        style={{
          ...deviceViewportStyle({ maxShortSide: DUO_STAGE_WIDTH, ratio: 1 }),
          containerType: 'inline-size',
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}>
        <div data-testid="device-screen-clip" style={{ position: 'absolute', inset: 0 }}>
          <FoldableDeviceScreen key={device.id} client={client} {...foldPreview} />
          {takeoverOverlay}
        </div>
      </div>
    );
  }

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
        // One responsive path clips both the stream and every overlay, which
        // avoids fractional seams between separate composited masks.
        clipPath: displayCorners
          ? deviceScreenCornersClipPath(displayCorners, false)
          : deviceScreenClipPath(radiusCqw, squircle),
      };

  return (
    <div
      data-testid="device-screen-frame"
      data-device-frame-kind={framed ? device.deviceFrame : 'none'}
      data-display-corners={displayCorners ? 'device' : undefined}
      data-agent-active={agentInteraction ? 'true' : 'false'}
      style={framed ? framed.frameStyle : { ...wrapperStyle, borderRadius }}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}>
      <div
        data-testid="device-screen-clip"
        data-device-frame-screen={framed ? 'true' : undefined}
        style={screenStyle}>
        <div
          data-testid="device-frame-stream-cover"
          style={framed ? framed.streamStyle : { position: 'absolute', inset: 0 }}>
          {deviceSurface}
        </div>
        {takeoverOverlay}
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
    </div>
  );
}
