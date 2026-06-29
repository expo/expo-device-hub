import { type CSSProperties, useState } from 'react';

import { bg, border, icon, radius, shadow } from '../theme/tokens';
import { SidebarIcon } from './icons';

/**
 * Toggle for showing/hiding the sidebar on narrow screens. `floating` renders
 * the bordered, elevated button that sits over the stream when the sidebar is
 * hidden; the default is the plain inline button used inside the sidebar header.
 */
export function SidebarToggle({ onClick, floating = false }: { onClick: () => void; floating?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const style: CSSProperties = floating
    ? {
        width: 40,
        height: 40,
        borderRadius: radius.lg,
        border: `1px solid ${border.default}`,
        backgroundColor: hovered ? bg.subtle : bg.default,
        boxShadow: shadow.xs,
      }
    : {
        width: 32,
        height: 32,
        borderRadius: radius.md,
        border: 'none',
        backgroundColor: hovered ? bg.element : 'transparent',
      };

  return (
    <button
      type="button"
      aria-label="Toggle sidebar"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        cursor: 'pointer',
        boxSizing: 'border-box',
        transition: 'background-color 150ms ease, transform 100ms ease',
        transform: pressed ? 'scale(0.98)' : undefined,
        ...style,
      }}>
      <SidebarIcon size={20} color={icon.default} />
    </button>
  );
}
