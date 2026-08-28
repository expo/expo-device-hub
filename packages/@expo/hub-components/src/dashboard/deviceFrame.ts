import { type DeviceOrientation } from '@expo/hub-client';

import { type DeviceFrameKind } from './data';

export type DeviceFrameRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DeviceFrameAsset = {
  src: string;
  width: number;
  height: number;
  screen: DeviceFrameRect;
  /** Conservative circular clip radius, measured in source-image pixels. */
  screenRadius: number;
  /** CSS superellipse parameter for the transparent screen opening. */
  screenSuperellipse: number;
};

export type DeviceFrameAssets = Record<DeviceFrameKind, DeviceFrameAsset>;

export type DeviceFrameRotation = -90 | 0 | 90 | 180;

export type DeviceFrameLayout = {
  width: number;
  height: number;
  rotation: DeviceFrameRotation;
  screen: DeviceFrameRect;
};

/** Rotate the physical frame in the same direction as the displayed device. */
export function deviceFrameRotation(
  orientation: DeviceOrientation | null | undefined,
  displayRatio: number,
): DeviceFrameRotation {
  switch (orientation) {
    case 'landscape_left':
      return 90;
    case 'landscape_right':
      return -90;
    case 'portrait_upside_down':
      return 180;
    default:
      return displayRatio > 1 ? 90 : 0;
  }
}

/** Map the portrait source artwork and screen opening into the current orientation. */
export function deviceFrameLayout(
  asset: Pick<DeviceFrameAsset, 'width' | 'height' | 'screen'>,
  rotation: DeviceFrameRotation,
): DeviceFrameLayout {
  const { width, height, screen } = asset;

  switch (rotation) {
    case 90:
      return {
        width: height,
        height: width,
        rotation,
        screen: {
          x: height - screen.y - screen.height,
          y: screen.x,
          width: screen.height,
          height: screen.width,
        },
      };
    case -90:
      return {
        width: height,
        height: width,
        rotation,
        screen: {
          x: screen.y,
          y: width - screen.x - screen.width,
          width: screen.height,
          height: screen.width,
        },
      };
    case 180:
      return {
        width,
        height,
        rotation,
        screen: {
          x: width - screen.x - screen.width,
          y: height - screen.y - screen.height,
          width: screen.width,
          height: screen.height,
        },
      };
    default:
      return { width, height, rotation, screen };
  }
}
