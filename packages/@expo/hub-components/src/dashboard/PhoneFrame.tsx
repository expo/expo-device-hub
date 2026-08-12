import { type ComponentType, type CSSProperties, useState } from 'react';

import {
  type AgentInteraction,
  type DeviceClient,
  type DeviceScreenProps,
  type ScreenSize,
} from '@expo/hub-client';
import { bg } from '../primitives';
import { AgentDeviceOverlay } from './AgentDeviceOverlay';
import { type Platform } from './data';
import { deviceScreenClipPath } from './deviceScreenClipPath';

const SHADOW = '0 40px 80px rgba(0, 0, 0, 0.4), 0 12px 28px rgba(0, 0, 0, 0.28)';

// Room reserved for the controls + panel padding when sizing by height.
const RESERVED_VERTICAL = 210;

// Cap on the device's *short* side (portrait width / landscape height). Sizing
// by the short side keeps the physical phone the same size across rotations:
// in landscape the long side lies horizontally, so what was the portrait
// height becomes the width instead of the frame shrinking into the old width.
const MAX_SHORT_SIDE = 480;

const CONFIG: Record<Platform, { ratio: number; radiusFraction: number; squircle: boolean }> = {
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
 * shrinking to the available height or panel width). The corner radius scales
 * with the rendered width via `cqw`, and once the stream reports its real
 * dimensions the frame adopts that exact aspect ratio so the live screen isn't
 * distorted.
 */
export function PhoneFrame({
  platform,
  client,
  agentInteraction,
  DeviceScreen,
  displayScreen,
}: {
  platform: Platform;
  client?: DeviceClient;
  agentInteraction?: AgentInteraction | null;
  /** Live-stream renderer, injected from `@expo/hub-client` by the consumer. */
  DeviceScreen: ComponentType<DeviceScreenProps>;
  /** Orientation-corrected screen sizer, injected from `@expo/hub-client`. */
  displayScreen: (screen?: ScreenSize | null) => ScreenSize | null;
}) {
  const [hovered, setHovered] = useState(false);
  const [dismissedInteractionId, setDismissedInteractionId] = useState<string | null>(null);
  const { ratio: fallbackRatio, radiusFraction, squircle } = CONFIG[platform];

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

  return (
    <div
      data-testid="device-screen-frame"
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
        {live ? (
          <DeviceScreen client={client} agentInteraction={agentInteraction} />
        ) : (
          <div style={{ width: '100%', height: '100%', backgroundColor: bg.element }} />
        )}
        <div
          data-testid="agent-device-overlay-clip"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 2,
            pointerEvents: overlayVisible ? 'auto' : 'none',
            backgroundColor: overlayVisible
              ? `color-mix(in srgb, ${bg.default} 68%, transparent)`
              : 'transparent',
            backdropFilter: overlayVisible ? 'blur(18px) saturate(120%)' : 'none',
            WebkitBackdropFilter: overlayVisible ? 'blur(18px) saturate(120%)' : 'none',
          }}>
          <AgentDeviceOverlay
            visible={overlayVisible}
            onTakeOver={() => setDismissedInteractionId(agentInteraction?.id ?? null)}
          />
        </div>
      </div>
    </div>
  );
}
