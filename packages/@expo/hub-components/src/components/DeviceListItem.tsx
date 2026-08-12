import { type CSSProperties, useState } from 'react';

import { WarningIcon } from './icons';
import { bg, icon, radius, text, textSize } from '../theme/tokens';
import { AgentDeviceStatus } from './AgentDeviceStatus';

/**
 * A selectable row in the simulators list ("list button"). Selected rows use the
 * `hover` surface, idle rows the `subtle` surface — matching the Figma states.
 */
export type DeviceListItemProps = {
  name: string;
  version: string;
  /** Shows an accessible warning for a device type that Hub does not support or test. */
  unsupported?: boolean;
  usedByAgent?: boolean;
  selected?: boolean;
  onClick?: () => void;
};

export function DeviceListItem({
  name,
  version,
  unsupported = false,
  usedByAgent = false,
  selected = false,
  onClick,
}: DeviceListItemProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const style: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    padding: 16,
    border: 'none',
    borderRadius: radius.xl,
    backgroundColor: selected ? bg.hover : hovered ? bg.element : 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    transition: 'background-color 150ms ease, transform 100ms ease',
    transform: pressed ? 'scale(0.98)' : undefined,
  };

  return (
    <button
      type="button"
      style={style}
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`${name}, ${version}${usedByAgent ? ', used by agent' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
        {unsupported && (
          <span
            role="img"
            aria-label="Unsupported or untested device"
            title="This device type is unsupported or untested."
            style={{ display: 'flex', flex: '0 0 auto', color: icon.warning }}>
            <WarningIcon size={16} />
          </span>
        )}
        <span
          title={name}
          style={{
            ...textSize.sm,
            flex: 1,
            minWidth: 0,
            fontWeight: 500,
            color: text.default,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
          {name}
        </span>
        <AgentDeviceStatus active={usedByAgent} />
      </span>
      <span
        style={{
          ...textSize.sm,
          fontWeight: 500,
          color: text.secondary,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}>
        {version}
      </span>
    </button>
  );
}
