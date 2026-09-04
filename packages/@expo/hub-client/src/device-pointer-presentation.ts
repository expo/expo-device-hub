import { type CSSProperties } from 'react';

export type DevicePointerLabelPlacement = {
  horizontal: 'left' | 'right';
  vertical: 'above' | 'below';
};

export const DEVICE_POINTER_SIZE = 31;
export const DEVICE_POINTER_LABEL_OFFSET_X = DEVICE_POINTER_SIZE;
export const DEVICE_POINTER_LABEL_OFFSET_Y = 23;

/** Shared pointer geometry used by both the agent and viewer cursors. */
export const DEVICE_POINTER_STYLE: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: DEVICE_POINTER_SIZE,
  height: DEVICE_POINTER_SIZE,
  transform: 'translate(-50%, -50%)',
};

/**
 * Shared attached-label treatment. The typography variables mirror
 * `@expo/hub-components`' `textSize.xs` token without creating a package cycle.
 */
export const DEVICE_POINTER_LABEL_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 29,
  padding: '0 12px',
  boxSizing: 'border-box',
  fontFamily: 'var(--expo-font-sans)',
  fontSize: 'var(--expo-text-size-xs-font-size)',
  fontWeight: 'var(--expo-text-size-xs-font-weight)',
  lineHeight: 'var(--expo-text-size-xs-line-height)',
  letterSpacing: 'var(--expo-text-size-xs-letter-spacing)',
  whiteSpace: 'nowrap',
};

/** Keep the small attached corner facing the pointer in every placement. */
export function devicePointerLabelRadius({
  horizontal,
  vertical,
}: DevicePointerLabelPlacement): string {
  const outer = 'var(--expo-radius-xl)';
  const attached = 'var(--expo-radius-sm)';
  const corners = [outer, outer, outer, outer];

  if (horizontal === 'right' && vertical === 'below') corners[0] = attached;
  if (horizontal === 'left' && vertical === 'below') corners[1] = attached;
  if (horizontal === 'left' && vertical === 'above') corners[2] = attached;
  if (horizontal === 'right' && vertical === 'above') corners[3] = attached;

  return corners.join(' ');
}
