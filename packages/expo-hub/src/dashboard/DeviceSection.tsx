import { useState } from 'react';

import { DeviceListItem } from '../../components/DeviceListItem';
import { PlusIcon } from '../../components/icons';
import { bg, border, icon, radius, text, textSize } from '../../theme/tokens';
import { type Device } from './data';

/**
 * A titled, selectable list of devices (Simulators or Emulators) with an add
 * button. Selection is controlled by the parent so it can be shared across
 * sections — only one device is "open" at a time.
 */
export type DeviceSectionProps = {
  title: string;
  addLabel: string;
  /** Shown under the heading when the list is empty. */
  emptyLabel: string;
  devices: Device[];
  selectedId: string;
  onSelect: (id: string) => void;
};

export function DeviceSection({
  title,
  addLabel,
  emptyLabel,
  devices,
  selectedId,
  onSelect,
}: DeviceSectionProps) {
  const [addHovered, setAddHovered] = useState(false);
  const [addPressed, setAddPressed] = useState(false);

  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>{title}</span>
        <button
          type="button"
          aria-label={addLabel}
          onMouseEnter={() => setAddHovered(true)}
          onMouseLeave={() => {
            setAddHovered(false);
            setAddPressed(false);
          }}
          onMouseDown={() => setAddPressed(true)}
          onMouseUp={() => setAddPressed(false)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            padding: 0,
            borderRadius: radius.full,
            border: `1px solid ${border.default}`,
            backgroundColor: addHovered ? bg.element : 'transparent',
            cursor: 'pointer',
            transition: 'background-color 150ms ease, transform 100ms ease',
            transform: addPressed ? 'scale(0.98)' : undefined,
          }}>
          <PlusIcon size={18} color={icon.secondary} />
        </button>
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        {devices.length === 0 ? (
          <p
            style={{
              ...textSize.sm,
              color: text.secondary,
              margin: 0,
              padding: '12px 16px',
              borderRadius: radius.xl,
              border: `1px dashed ${border.default}`,
              backgroundColor: bg.subtle,
            }}>
            {emptyLabel}
          </p>
        ) : (
          devices.map((device) => (
            <DeviceListItem
              key={device.id}
              name={device.name}
              version={device.version}
              selected={device.id === selectedId}
              onClick={() => onSelect(device.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}
