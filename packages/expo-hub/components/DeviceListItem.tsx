import { type CSSProperties, useState } from 'react';

import { bg, radius, text, textSize } from '../theme/tokens';

/**
 * A selectable row in the simulators list ("list button"). Selected rows use the
 * `hover` surface, idle rows the `subtle` surface — matching the Figma states.
 */
export type DeviceListItemProps = {
  name: string;
  version: string;
  selected?: boolean;
  onClick?: () => void;
};

export function DeviceListItem({ name, version, selected = false, onClick }: DeviceListItemProps) {
  const [hovered, setHovered] = useState(false);

  const style: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    width: '100%',
    padding: 16,
    border: 'none',
    borderRadius: radius.xl,
    backgroundColor: selected ? bg.hover : hovered ? bg.element : bg.subtle,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    transition: 'background-color 150ms ease',
  };

  return (
    <button
      type="button"
      style={style}
      onClick={onClick}
      aria-pressed={selected}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}>
      <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>{name}</span>
      <span style={{ ...textSize.sm, fontWeight: 500, color: text.secondary }}>{version}</span>
    </button>
  );
}
