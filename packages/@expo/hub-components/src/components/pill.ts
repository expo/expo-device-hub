import { type CSSProperties } from 'react';

import { bg, border, radius, shadow, text, textSize } from '../theme/tokens';

export const PILL_CONTROL_HEIGHT = 28;

/**
 * The shared look of the inspector's compact controls — select triggers and
 * action buttons — so every control on a sidebar row reads as the same pill.
 */
export function pillControlStyle({
  hovered = false,
  focused = false,
  disabled = false,
}: {
  hovered?: boolean;
  focused?: boolean;
  disabled?: boolean;
} = {}): CSSProperties {
  return {
    ...textSize.sm,
    display: 'inline-flex',
    height: PILL_CONTROL_HEIGHT,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    boxSizing: 'border-box',
    padding: '0 10px',
    border: `1px solid ${border.default}`,
    borderRadius: radius.lg,
    outline: 'none',
    backgroundColor: hovered && !disabled ? bg.hover : bg.element,
    boxShadow: focused ? `0 0 0 2px ${border.secondary}` : shadow.none,
    color: text.default,
    fontFamily: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'background-color 120ms ease',
  };
}
