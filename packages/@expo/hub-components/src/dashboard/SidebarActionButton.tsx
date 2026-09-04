import { type ReactNode, useState } from 'react';

import { isFocusVisible, pillControlStyle, text } from '../primitives';

/**
 * A compact action button that matches the inspector's select pills and
 * presses in slightly while the pointer (or Space/Enter) is held.
 */
export function SidebarActionButton({
  children,
  disabled = false,
  destructive = false,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  /** Color the label as a destructive action (e.g. removing a device). */
  destructive?: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pressed, setPressed] = useState(false);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') setPressed(true);
      }}
      onKeyUp={() => setPressed(false)}
      onFocus={(event) => setFocused(isFocusVisible(event))}
      onBlur={() => {
        setFocused(false);
        setPressed(false);
      }}
      style={{
        ...pillControlStyle({ hovered, focused, disabled }),
        color: destructive ? text.danger : text.default,
        transform: pressed && !disabled ? 'scale(0.96)' : undefined,
        transition: 'background-color 120ms ease, transform 100ms ease',
      }}>
      {children}
    </button>
  );
}
