import { type ComponentType, type CSSProperties, useState } from 'react';

import {
  type AgentInteraction,
  type DeviceClient,
  type DeviceScreenProps,
  type ScreenSize,
} from '@expo/hub-client';
import { bg } from '../primitives';
import { AgentDeviceOverlay } from './AgentDeviceOverlay';
import { type Device } from './data';
import {
  deviceFrameLayout,
  deviceFrameRotation,
  type DeviceFrameAsset,
  type DeviceFrameAssets,
  type DeviceFrameLayout,
} from './deviceFrame';
import { deviceFrameScreenClipPath, deviceScreenClipPath } from './deviceScreenClipPath';

const SHADOW = '0 40px 80px rgba(0, 0, 0, 0.4), 0 12px 28px rgba(0, 0, 0, 0.28)';

// Room reserved for the title, controls, gaps, and panel padding when sizing by height.
const RESERVED_VERTICAL = 258;

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

function percent(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(4)}%`;
}

function frameArtworkStyle(asset: DeviceFrameAsset, layout: DeviceFrameLayout): CSSProperties {
  const centered: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    userSelect: 'none',
    pointerEvents: 'none',
  };

  if (Math.abs(layout.rotation) === 90) {
    return {
      ...centered,
      width: percent(asset.width, layout.width),
      height: percent(asset.height, layout.height),
      transform: `translate(-50%, -50%) rotate(${layout.rotation}deg)`,
    };
  }

  return {
    ...centered,
    width: '100%',
    height: '100%',
    transform: `translate(-50%, -50%) rotate(${layout.rotation}deg)`,
  };
}

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
  const maxWidth = MAX_SHORT_SIDE * Math.max(ratio, 1);
  const wrapperStyle: CSSProperties = {
    width: `min(${maxWidth}px, calc((100vh - ${RESERVED_VERTICAL}px) * ${ratio}), 100%)`,
    aspectRatio: `${ratio}`,
    containerType: 'inline-size',
    position: 'relative',
    isolation: 'isolate',
  };

  // `cqw` resolves against the width, but the radius should stay a fraction of
  // the *short* side so the corners look the same in portrait and landscape.
  const radiusCqw = (radiusFraction / Math.max(ratio, 1)) * 100;
  const borderRadius = `${radiusCqw.toFixed(3)}cqw`;
  const live = client && client.status !== 'idle';
  const overlayVisible =
    !!agentInteraction && hovered && dismissedInteractionId !== agentInteraction.id;

  const deviceSurface = live ? (
    <DeviceScreen client={client} agentInteraction={agentInteraction} />
  ) : (
    <div style={{ width: '100%', height: '100%', backgroundColor: bg.element }} />
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

  const frameAsset =
    showDeviceFrame && device.deviceFrame ? deviceFrameAssets?.[device.deviceFrame] : undefined;

  if (frameAsset) {
    const rotation = deviceFrameRotation(client?.screen?.orientation, ratio);
    const layout = deviceFrameLayout(frameAsset, rotation);
    const frameRatio = layout.width / layout.height;
    const screenShortSideFraction = frameAsset.screen.width / frameAsset.width;
    const maxFrameShortSide = MAX_SHORT_SIDE / screenShortSideFraction;
    const maxFrameWidth = maxFrameShortSide * Math.max(frameRatio, 1);
    const radiusXPercent = (frameAsset.screenRadius / layout.screen.width) * 100;
    const radiusYPercent = (frameAsset.screenRadius / layout.screen.height) * 100;
    const radiusX = `${radiusXPercent.toFixed(4)}%`;
    const radiusY = `${radiusYPercent.toFixed(4)}%`;
    const frameScreenCornerStyle = {
      borderRadius: `${radiusX} / ${radiusY}`,
      '--expo-device-frame-corner-shape': `superellipse(${frameAsset.screenSuperellipse})`,
    } as CSSProperties;
    const screenClip = deviceFrameScreenClipPath(
      radiusXPercent,
      radiusYPercent,
      frameAsset.screenSuperellipse
    );
    const openingRatio = layout.screen.width / layout.screen.height;
    const streamCoverStyle: CSSProperties =
      ratio > openingRatio
        ? {
            position: 'absolute',
            top: 0,
            left: '50%',
            width: `${((ratio / openingRatio) * 100).toFixed(4)}%`,
            height: '100%',
            transform: 'translateX(-50%)',
          }
        : {
            position: 'absolute',
            top: '50%',
            left: 0,
            width: '100%',
            height: `${((openingRatio / ratio) * 100).toFixed(4)}%`,
            transform: 'translateY(-50%)',
          };

    return (
      <div
        data-testid="device-screen-frame"
        data-device-frame-kind={device.deviceFrame}
        data-agent-active={agentInteraction ? 'true' : 'false'}
        style={{
          width: `min(${maxFrameWidth}px, calc((100vh - ${RESERVED_VERTICAL}px) * ${frameRatio}), 100%)`,
          aspectRatio: `${frameRatio}`,
          position: 'relative',
          isolation: 'isolate',
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}>
        <div
          data-testid="device-screen-clip"
          data-device-frame-screen="true"
          style={{
            position: 'absolute',
            left: percent(layout.screen.x, layout.width),
            top: percent(layout.screen.y, layout.height),
            width: percent(layout.screen.width, layout.width),
            height: percent(layout.screen.height, layout.height),
            zIndex: 1,
            overflow: 'hidden',
            ...frameScreenCornerStyle,
            clipPath: screenClip,
            backgroundColor: bg.element,
          }}>
          <div data-testid="device-frame-stream-cover" style={streamCoverStyle}>
            {deviceSurface}
          </div>
          {takeoverOverlay}
        </div>
        <img
          data-testid="device-frame-artwork"
          src={frameAsset.src}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          style={{ ...frameArtworkStyle(frameAsset, layout), zIndex: 2 }}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="device-screen-frame"
      data-device-frame-kind="none"
      data-agent-active={agentInteraction ? 'true' : 'false'}
      style={{ ...wrapperStyle, boxShadow: SHADOW, borderRadius }}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}>
      <div
        data-testid="device-screen-clip"
        style={{
          position: 'absolute',
          inset: 0,
          // One responsive path clips both the stream and every overlay, which
          // avoids fractional seams between separate composited masks.
          clipPath: deviceScreenClipPath(radiusCqw, squircle),
        }}>
        <div data-testid="device-frame-stream-cover" style={{ position: 'absolute', inset: 0 }}>
          {deviceSurface}
        </div>
        {takeoverOverlay}
      </div>
    </div>
  );
}
