import { type ButtonHTMLAttributes, forwardRef, useState } from 'react';

import { text } from '../theme/tokens';
import { isFocusVisible } from './focusVisible';
import { pillControlStyle } from './pill';

export type PillButtonProps = {
  /** Color the label as a destructive action (e.g. removing a device). */
  destructive?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * A compact action button in the inspector's pill style ({@link pillControlStyle}),
 * so it reads as the same control as a `Select` trigger on a neighbouring row.
 * It presses in slightly while the pointer or Space/Enter is held, and shows a
 * focus ring only for keyboard focus.
 *
 * `Button` stays the general-purpose primitive; this one exists for the
 * controls that sit next to select pills. Forwards its ref and spreads extra
 * props onto the underlying `<button>`.
 */
export const PillButton = forwardRef<HTMLButtonElement, PillButtonProps>(function PillButton(
  {
    destructive = false,
    disabled = false,
    style,
    children,
    onMouseEnter,
    onMouseLeave,
    onMouseDown,
    onMouseUp,
    onKeyDown,
    onKeyUp,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pressed, setPressed] = useState(false);

  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onMouseEnter={(event) => {
        setHovered(true);
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        setHovered(false);
        setPressed(false);
        onMouseLeave?.(event);
      }}
      onMouseDown={(event) => {
        setPressed(true);
        onMouseDown?.(event);
      }}
      onMouseUp={(event) => {
        setPressed(false);
        onMouseUp?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') setPressed(true);
        onKeyDown?.(event);
      }}
      onKeyUp={(event) => {
        setPressed(false);
        onKeyUp?.(event);
      }}
      onFocus={(event) => {
        setFocused(isFocusVisible(event));
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        setPressed(false);
        onBlur?.(event);
      }}
      style={{
        ...pillControlStyle({ hovered, focused, disabled }),
        color: destructive ? text.danger : text.default,
        transform: pressed && !disabled ? 'scale(0.96)' : undefined,
        transition: 'background-color 120ms ease, transform 100ms ease',
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
});
