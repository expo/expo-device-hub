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
  devices: Device[];
  selectedId: string;
  onSelect: (id: string) => void;
};

export function DeviceSection({ title, addLabel, devices, selectedId, onSelect }: DeviceSectionProps) {
  const [addHovered, setAddHovered] = useState(false);

  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>{title}</span>
        <button
          type="button"
          aria-label={addLabel}
          onMouseEnter={() => setAddHovered(true)}
          onMouseLeave={() => setAddHovered(false)}
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
            transition: 'background-color 150ms ease',
          }}>
          <PlusIcon size={18} color={icon.secondary} />
        </button>
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        {devices.map((device) => (
          <DeviceListItem
            key={device.id}
            name={device.name}
            version={device.version}
            selected={device.id === selectedId}
            onClick={() => onSelect(device.id)}
          />
        ))}
      </div>
    </section>
  );
}
