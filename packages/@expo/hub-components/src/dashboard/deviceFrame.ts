import { type CSSProperties } from 'react';
import { type DeviceOrientation } from '@expo/hub-client';

import { type DeviceFrameProfileId } from './data';

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
};

export type DeviceFrameAssets = Record<DeviceFrameProfileId, DeviceFrameAsset>;

export type DeviceFrameRotation = -90 | 0 | 90 | 180;

export type DeviceFrameLayout = {
  width: number;
  height: number;
  rotation: DeviceFrameRotation;
  screen: DeviceFrameRect;
};

export type DeviceFramePresentation = {
  frameStyle: CSSProperties;
  screenStyle: CSSProperties;
  streamStyle: CSSProperties;
  artworkStyle: CSSProperties;
};

const SCREEN_BLEED_PX = 1;

/** Keep a device's aspect ratio while fitting the exact panel viewport. */
export function deviceViewportStyle({
  maxShortSide,
  ratio,
}: {
  maxShortSide: number;
  ratio: number;
}): CSSProperties {
  const maxWidth = maxShortSide * Math.max(ratio, 1);

  return {
    width: `min(${maxWidth}px, 100cqw, ${(ratio * 100).toFixed(6)}cqh)`,
    aspectRatio: `${ratio}`,
    flexShrink: 0,
    position: 'relative',
    isolation: 'isolate',
  };
}

function percent(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(4)}%`;
}

function artworkStyle(
  asset: DeviceFrameAsset,
  layout: DeviceFrameLayout,
): CSSProperties {
  const centered: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    userSelect: 'none',
    pointerEvents: 'none',
    zIndex: 2,
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

/**
 * Resolve all responsive artwork, clip, and stream geometry for a framed device.
 * The clip extends one CSS pixel beneath the artwork on every edge. The stream
 * then covers that expanded clip while retaining the live display aspect ratio.
 */
export function deviceFramePresentation({
  asset,
  orientation,
  displayRatio,
  maxScreenShortSide,
}: {
  asset: DeviceFrameAsset;
  orientation: DeviceOrientation | null | undefined;
  displayRatio: number;
  maxScreenShortSide: number;
}): DeviceFramePresentation {
  const rotation = deviceFrameRotation(orientation, displayRatio);
  const layout = deviceFrameLayout(asset, rotation);
  const frameRatio = layout.width / layout.height;
  const screenShortSideFraction = asset.screen.width / asset.width;
  const maxFrameShortSide = maxScreenShortSide / screenShortSideFraction;
  const screenRadiusX = `${((asset.screenRadius / layout.width) * 100).toFixed(4)}cqw`;
  const screenRadiusY = `${((asset.screenRadius / layout.height) * 100).toFixed(4)}cqh`;

  return {
    frameStyle: {
      ...deviceViewportStyle({ maxShortSide: maxFrameShortSide, ratio: frameRatio }),
      containerType: 'size',
    },
    screenStyle: {
      position: 'absolute',
      left: `calc(${percent(layout.screen.x, layout.width)} - ${SCREEN_BLEED_PX}px)`,
      top: `calc(${percent(layout.screen.y, layout.height)} - ${SCREEN_BLEED_PX}px)`,
      width: `calc(${percent(layout.screen.width, layout.width)} + ${SCREEN_BLEED_PX * 2}px)`,
      height: `calc(${percent(layout.screen.height, layout.height)} + ${SCREEN_BLEED_PX * 2}px)`,
      containerType: 'size',
      zIndex: 1,
      overflow: 'hidden',
      borderRadius: `calc(${screenRadiusX} + ${SCREEN_BLEED_PX}px) / calc(${screenRadiusY} + ${SCREEN_BLEED_PX}px)`,
    } as CSSProperties,
    streamStyle: {
      position: 'absolute',
      top: '50%',
      left: '50%',
      width: `max(100cqw, ${(displayRatio * 100).toFixed(6)}cqh)`,
      height: `max(100cqh, ${(100 / displayRatio).toFixed(6)}cqw)`,
      aspectRatio: `${displayRatio}`,
      transform: 'translate(-50%, -50%)',
    },
    artworkStyle: artworkStyle(asset, layout),
  };
}
