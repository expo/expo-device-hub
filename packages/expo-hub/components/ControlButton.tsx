import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  forwardRef,
  type ReactNode,
  useState,
} from 'react';

import { bg, border, icon as iconColor, radius, text, textSize } from '../theme/tokens';

/**
 * A circular icon button with a caption below it — the controls under the device
 * stream (Reload, Home, Save, More). `variant="primary"` renders the larger,
 * black, filled circle used for the active/home action.
 *
 * Forwards its ref and spreads extra props onto the underlying `<button>`, so it
 * can be used as a Radix `asChild` trigger (e.g. for the More dropdown).
 */
export type ControlButtonProps = {
  icon: ReactNode;
  label: string;
  variant?: 'default' | 'primary';
} & ButtonHTMLAttributes<HTMLButtonElement>;

export const ControlButton = forwardRef<HTMLButtonElement, ControlButtonProps>(
  function ControlButton(
    { icon, label, variant = 'default', style, onMouseEnter, onMouseLeave, onMouseDown, onMouseUp, ...rest },
    ref
  ) {
    const [hovered, setHovered] = useState(false);
    const [pressed, setPressed] = useState(false);
    const primary = variant === 'primary';
    const diameter = primary ? 60 : 32;

    const circleStyle: CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: diameter,
      height: diameter,
      borderRadius: radius.full,
      boxSizing: 'border-box',
      border: primary ? 'none' : `1px solid ${border.default}`,
      backgroundColor: primary ? text.default : hovered ? bg.element : 'transparent',
      color: primary ? bg.default : iconColor.default,
      opacity: primary && hovered ? 0.85 : 1,
      transition: 'background-color 150ms ease, opacity 150ms ease',
    };

    return (
      <button
        ref={ref}
        type="button"
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
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          padding: 0,
          border: 'none',
          background: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition: 'transform 100ms ease',
          transform: pressed ? 'scale(0.98)' : undefined,
          ...style,
        }}
        {...rest}>
        <span style={circleStyle}>{icon}</span>
        <span style={{ ...textSize['2xs'], color: text.secondary, textAlign: 'center' }}>{label}</span>
      </button>
    );
  }
);
