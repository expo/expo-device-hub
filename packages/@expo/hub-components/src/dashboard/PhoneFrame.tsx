import { type ComponentType, type CSSProperties, useEffect, useRef, useState } from 'react';

import {
  type AgentInteraction,
  type DeviceClient,
  type DeviceScreenProps,
  type ScreenSize,
} from '@expo/hub-client';
import {
  CableDisconnectIcon,
  bg,
  border,
  heading,
  icon,
  radius,
  text,
  textSize,
} from '../primitives';
import { AgentDeviceOverlay } from './AgentDeviceOverlay';
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
  available = true,
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
  /** Keep the frame visible while replacing an unavailable device's stream. */
  available?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [dismissedInteractionId, setDismissedInteractionId] = useState<string | null>(null);
  const lastScreen = useRef<{ deviceId: string; screen: ScreenSize } | null>(null);
  useEffect(() => {
    if (available && client?.screen) {
      lastScreen.current = { deviceId: device.id, screen: client.screen };
    } else if (lastScreen.current?.deviceId !== device.id) {
      lastScreen.current = null;
    }
  }, [available, client?.screen, device.id]);
  const { ratio: fallbackRatio, radiusFraction, squircle } = CONFIG[device.platform];

  // Prefer the live screen's aspect ratio once known, so the stream fills the
  // frame 1:1 instead of being stretched to the placeholder's body ratio. Uses
  // the orientation-corrected (display) size so a rotated device shows landscape.
  // Disconnecting resets the client's screen. Keep the last geometry for this
  // device so an offline landscape screen and its controls do not jump.
  const screen =
    (available ? client?.screen : null) ??
    (lastScreen.current?.deviceId === device.id ? lastScreen.current.screen : null);
  const display = displayScreen(screen);
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
  const live = available && client && client.status !== 'idle';
  const overlayVisible =
    available && !!agentInteraction && hovered && dismissedInteractionId !== agentInteraction.id;

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

  const frameAsset =
    showDeviceFrame && device.deviceFrame ? deviceFrameAssets?.[device.deviceFrame] : undefined;
  const framed = frameAsset
    ? deviceFramePresentation({
        asset: frameAsset,
        orientation: screen?.orientation,
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
        clipPath: deviceScreenClipPath(radiusCqw, squircle),
      };

  return (
    <div
      data-testid="device-screen-frame"
      data-device-frame-kind={framed ? device.deviceFrame : 'none'}
      data-agent-active={available && agentInteraction ? 'true' : 'false'}
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
          {available ? deviceSurface : null}
        </div>
        {!available && <UnavailableDeviceScreen />}
        {available && takeoverOverlay}
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

/** Stays inside the calibrated screen opening, independent of stream cropping. */
function UnavailableDeviceScreen() {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="device-unavailable-screen"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        padding: '24px 20px',
        gap: 16,
        backgroundColor: bg.screen,
        textAlign: 'center',
      }}>
      <span
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: 48,
          height: 48,
          border: `1px solid ${border.default}`,
          borderRadius: radius.xl,
          backgroundColor: bg.default,
          color: icon.secondary,
        }}>
        <CableDisconnectIcon size={24} />
      </span>
      <div style={{ display: 'grid', gap: 8, maxWidth: 240 }}>
        <span style={{ ...heading.base, color: text.default }}>Device unavailable</span>
        <p style={{ ...textSize.sm, color: text.secondary, margin: 0 }}>
          This device is offline. Its screen will return when it reconnects.
        </p>
      </div>
    </div>
  );
}
