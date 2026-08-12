import { type CSSProperties, useRef, useState } from 'react';

import { bg, radius, text, textSize } from '../theme/tokens';
import { AgentDeviceStatus } from './AgentDeviceStatus';
import { useCompactAgentDeviceStatus } from './useCompactAgentDeviceStatus';

/**
 * A selectable row in the simulators list ("list button"). Selected rows use the
 * `hover` surface, idle rows the `subtle` surface — matching the Figma states.
 */
export type DeviceListItemProps = {
  name: string;
  version: string;
  usedByAgent?: boolean;
  selected?: boolean;
  onClick?: () => void;
};

export function DeviceListItem({
  name,
  version,
  usedByAgent = false,
  selected = false,
  onClick,
}: DeviceListItemProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const statusLabelRef = useRef<HTMLSpanElement>(null);
  const versionRef = useRef<HTMLSpanElement>(null);
  const compactAgentStatus = useCompactAgentDeviceStatus({
    buttonRef,
    nameRef,
    statusLabelRef,
    versionRef,
  });

  const style: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    width: '100%',
    minWidth: 0,
    padding: 16,
    boxSizing: 'border-box',
    overflow: 'hidden',
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
      ref={buttonRef}
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
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
        }}>
        <span
          ref={nameRef}
          title={name}
          style={{
            ...textSize.sm,
            minWidth: 0,
            flex: '1 1 auto',
            fontWeight: 500,
            color: text.default,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
          {name}
        </span>
        <AgentDeviceStatus
          active={usedByAgent}
          compact={compactAgentStatus}
          labelRef={statusLabelRef}
        />
      </span>
      <span
        ref={versionRef}
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
