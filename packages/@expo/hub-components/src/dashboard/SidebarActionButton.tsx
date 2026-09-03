import { type ReactNode, useState } from 'react';

import { pillControlStyle, text } from '../primitives';

/** A compact action button that matches the inspector's select pills. */
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

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        ...pillControlStyle({ hovered, focused, disabled }),
        color: destructive ? text.danger : text.default,
      }}>
      {children}
    </button>
  );
}
