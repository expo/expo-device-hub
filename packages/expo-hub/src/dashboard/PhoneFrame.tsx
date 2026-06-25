import { type CSSProperties } from 'react';

import androidPlaceholder from '../../assets/android-placeholder.png';
import iosPlaceholder from '../../assets/simulator-placeholder.png';
import { type DeviceClient, DeviceScreen, displayScreen } from '../device';
import { type Platform } from './data';

// The bundler returns a URL string on web; guard for the native asset shape too.
function toUrl(asset: unknown): string {
  return typeof asset === 'string' ? asset : ((asset as { uri?: string }).uri ?? '');
}

const SRC: Record<Platform, string> = {
  ios: toUrl(iosPlaceholder),
  android: toUrl(androidPlaceholder),
};

const SHADOW = '0 40px 80px rgba(0, 0, 0, 0.4), 0 12px 28px rgba(0, 0, 0, 0.28)';

// Room reserved for the controls + panel padding when sizing by height.
const RESERVED_VERTICAL = 210;

const CONFIG: Record<Platform, { ratio: number; radiusFraction: number; squircle: boolean }> = {
  ios: { ratio: 320 / 695, radiusFraction: 102 / 390, squircle: true },
  android: { ratio: 320 / 711, radiusFraction: 10 / 390, squircle: false },
};

/**
 * The selected device's screen. When a {@link DeviceClient} connection is active
 * (a serve-sim/serve-emu server is selected) it renders the live, interactive
 * {@link DeviceScreen}; otherwise it falls back to the static placeholder image.
 *
 * The phone stays as large as fits (cap 320px, shrinking to the available height
 * or panel width). The corner radius scales with the rendered width via `cqw`,
 * and once the stream reports its real dimensions the frame adopts that exact
 * aspect ratio so the live screen isn't distorted.
 */
export function PhoneFrame({ platform, client }: { platform: Platform; client?: DeviceClient }) {
  const { ratio: fallbackRatio, radiusFraction, squircle } = CONFIG[platform];
  const isIos = platform === 'ios';

  // Prefer the live screen's aspect ratio once known, so the stream fills the
  // frame 1:1 instead of being stretched to the placeholder's body ratio. Uses
  // the orientation-corrected (display) size so a rotated device shows landscape.
  const display = client ? displayScreen(client.screen) : null;
  const ratio = display && display.height > 0 ? display.width / display.height : fallbackRatio;

  // The container's width is the phone width; `cqw` on the child resolves
  // against it, so the radius is always `radiusFraction` of the rendered width.
  const wrapperStyle: CSSProperties = {
    width: `min(320px, calc((100vh - ${RESERVED_VERTICAL}px) * ${ratio}), 100%)`,
    aspectRatio: `${ratio}`,
    containerType: 'inline-size',
  };

  const borderRadius = `${(radiusFraction * 100).toFixed(3)}cqw`;
  const live = client && client.status !== 'idle';

  return (
    <div style={{ ...wrapperStyle, boxShadow: SHADOW, borderRadius }}>
      {live ? (
        <DeviceScreen client={client} borderRadius={borderRadius} squircle={squircle} />
      ) : (
        <img
          src={SRC[platform]}
          alt={isIos ? 'iOS device screen' : 'Android device screen'}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            borderRadius,
            ...(squircle ? ({ cornerShape: 'squircle' } as Record<string, unknown>) : {}),
          }}
        />
      )}
    </div>
  );
}
