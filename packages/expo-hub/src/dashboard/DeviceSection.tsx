import { useState } from 'react';

import { DeviceListItem } from '../../components/DeviceListItem';
import { PlusIcon } from '../../components/icons';
import { bg, border, icon, radius, text, textSize } from '../../theme/tokens';
import { type Device } from './data';
import { RecentDevicesModal } from './RecentDevicesModal';
import { type NewDeviceOptions } from './useNewDeviceOptions';

/**
 * A titled, selectable list of devices (Simulators or Emulators) with an add
 * button. Selection is controlled by the parent so it can be shared across
 * sections — only one device is "open" at a time. The add button opens the
 * "Add a simulator/emulator" picker; the chosen (or newly configured) device is
 * reported via `onAdd`.
 */
export type DeviceSectionProps = {
  title: string;
  addLabel: string;
  /** Drives the add-device picker's nouns ("simulator" / "emulator"). */
  kind: 'simulator' | 'emulator';
  /** Shown under the heading when the list is empty. */
  emptyLabel: string;
  devices: Device[];
  /** Devices that could be added (the modal hides any already shown here). */
  recent: Device[];
  /** Mocked OS versions + models for the picker's "New <kind>" form. */
  options: NewDeviceOptions;
  selectedId: string;
  onSelect: (id: string) => void;
  /** Called with the device chosen (or configured) in the add-device modal. */
  onAdd?: (device: Device) => void;
};

export function DeviceSection({
  title,
  addLabel,
  kind,
  emptyLabel,
  devices,
  recent,
  options,
  selectedId,
  onSelect,
  onAdd,
}: DeviceSectionProps) {
  const [addHovered, setAddHovered] = useState(false);
  const [addPressed, setAddPressed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // Don't offer devices that are already in this section's list.
  const shownIds = new Set(devices.map((device) => device.id));
  const candidates = recent.filter((device) => !shownIds.has(device.id));

  return (
    <section style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>{title}</span>
        {
          !!onAdd && <button
            type="button"
            aria-label={addLabel}
            onClick={() => setModalOpen(true)}
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
        }
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

      <RecentDevicesModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        kind={kind}
        devices={candidates}
        options={options}
        onAdd={onAdd || (() => {})}
      />
    </section>
  );
}
