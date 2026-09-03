import { type ButtonHTMLAttributes, forwardRef, type ReactNode, useState } from 'react';

import { bg, border, icon as iconColor, radius, text, textSize } from '../theme/tokens';

export const CONTROL_BUTTON_SIZE = 44;

/**
 * An icon button in the toolbar under the device stream. The label is the
 * button's accessible name and appears as a tooltip above the button while it
 * is hovered or focused.
 *
 * Forwards its ref and spreads extra props onto the underlying `<button>`, so
 * it can also serve as a Radix `asChild` trigger.
 */
export type ControlButtonProps = {
  icon: ReactNode;
  label: string;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export const ControlButton = forwardRef<HTMLButtonElement, ControlButtonProps>(
  function ControlButton(
    { icon, label, style, onMouseEnter, onMouseLeave, onMouseDown, onMouseUp, onFocus, onBlur, ...rest },
    ref
  ) {
    const [hovered, setHovered] = useState(false);
    const [pressed, setPressed] = useState(false);
    const [focused, setFocused] = useState(false);
    const tooltipVisible = hovered || focused;

    return (
      <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
        <button
          ref={ref}
          type="button"
          aria-label={label}
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
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: CONTROL_BUTTON_SIZE,
            height: CONTROL_BUTTON_SIZE,
            padding: 0,
            border: 'none',
            // Concentric with the surrounding group (radius.xl minus its padding).
            borderRadius: `calc(${radius.xl} - 4px)`,
            outline: 'none',
            backgroundColor: hovered ? bg.hover : 'transparent',
            boxShadow: focused ? `0 0 0 2px ${border.secondary}` : 'none',
            color: iconColor.default,
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'background-color 150ms ease, transform 100ms ease',
            transform: pressed ? 'scale(0.96)' : undefined,
            ...style,
          }}
          {...rest}>
          {icon}
        </button>
        <span
          role="tooltip"
          aria-hidden="true"
          style={{
            ...textSize.xs,
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: '50%',
            zIndex: 1,
            padding: '3px 8px',
            borderRadius: radius.md,
            backgroundColor: text.default,
            color: bg.default,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            opacity: tooltipVisible ? 1 : 0,
            transform: 'translateX(-50%)',
            transition: 'opacity 120ms ease',
          }}>
          {label}
        </span>
      </span>
    );
  }
);
