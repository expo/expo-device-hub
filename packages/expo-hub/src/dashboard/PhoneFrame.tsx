import { type CSSProperties } from 'react';

import androidPlaceholder from '../../assets/android-placeholder.png';
import iosPlaceholder from '../../assets/simulator-placeholder.png';
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
 * The selected device's screen, used as a static placeholder. The phone stays
 * as large as fits (cap 320px, shrinking to the available height or panel
 * width); the corner radius scales with the rendered width via `cqw`, so it
 * looks the same on large and small layouts.
 */
export function PhoneFrame({ platform }: { platform: Platform }) {
  const { ratio, radiusFraction, squircle } = CONFIG[platform];
  const isIos = platform === 'ios';

  // The container's width is the phone width; `cqw` on the image resolves
  // against it, so the radius is always `radiusFraction` of the rendered width.
  const wrapperStyle: CSSProperties = {
    width: `min(320px, calc((100vh - ${RESERVED_VERTICAL}px) * ${ratio}), 100%)`,
    containerType: 'inline-size',
  };

  const imgStyle: CSSProperties = {
    display: 'block',
    width: '100%',
    height: 'auto',
    boxShadow: SHADOW,
    borderRadius: `${(radiusFraction * 100).toFixed(3)}cqw`,
  };
  if (squircle) {
    (imgStyle as Record<string, unknown>).cornerShape = 'squircle';
  }

  return (
    <div style={wrapperStyle}>
      <img
        src={SRC[platform]}
        alt={isIos ? 'iOS device screen' : 'Android device screen'}
        style={imgStyle}
      />
    </div>
  );
}
