import { memo, useState } from 'react';

import { DeviceListItem, PlusIcon, bg, border, icon, radius, text, textSize } from '../primitives';
import { RecentDevicesModal } from './RecentDevicesModal';
import {
  deviceStartupLabel,
  type AddDeviceOutcome,
  type AddDeviceTarget,
  type Device,
  type NewDeviceOptions,
} from './data';

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
  /** Installed runtimes/system images and compatible models for new devices. */
  options: NewDeviceOptions;
  agentDeviceIds?: readonly string[];
  selectedId: string;
  /** Retained selected device missing from the running-device list. */
  offlineDeviceId?: string;
  onSelect: (id: string) => void;
  /** Starts the existing or newly configured device selected in the modal. */
  onAdd?: (target: AddDeviceTarget) => Promise<AddDeviceOutcome>;
};

export const DeviceSection = memo(function DeviceSection({
  title,
  addLabel,
  kind,
  emptyLabel,
  devices,
  recent,
  options,
  agentDeviceIds = [],
  selectedId,
  offlineDeviceId,
  onSelect,
  onAdd,
}: DeviceSectionProps) {
  const [addHovered, setAddHovered] = useState(false);
  const [addPressed, setAddPressed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // A retained offline row can still be restarted from the add-device picker.
  const shownIds = new Set(
    devices
      .filter(
        (device) =>
          device.startup?.phase !== 'failed' && (device.id !== offlineDeviceId || !!device.startup)
      )
      .map((device) => device.id)
  );
  const startingAvds = new Set(
    devices
      .filter(
        (device) =>
          device.platform === 'android' && device.startup && device.startup.phase !== 'failed'
      )
      .map((device) => device.name)
  );
  const candidates = recent.filter(
    (device) =>
      !shownIds.has(device.id) && !(device.platform === 'android' && startingAvds.has(device.name))
  );

  return (
    <section style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>{title}</span>
        {!!onAdd && (
          <button
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
              backgroundColor: addHovered ? bg.hover : bg.default,
              cursor: 'pointer',
              transition: 'background-color 150ms ease, transform 100ms ease',
              transform: addPressed ? 'scale(0.98)' : undefined,
            }}>
            <PlusIcon size={18} color={icon.secondary} />
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
        {devices.length === 0 ? (
          <p
            style={{
              ...textSize.sm,
              color: text.secondary,
              margin: 0,
              padding: '12px 16px',
              borderRadius: radius.xl,
              border: `1px dashed ${border.default}`,
              backgroundColor: bg.default,
            }}>
            {emptyLabel}
          </p>
        ) : (
          devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              offline={device.id === offlineDeviceId}
              usedByAgent={device.id !== offlineDeviceId && agentDeviceIds.includes(device.id)}
              selected={device.id === selectedId}
              onSelect={onSelect}
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
        onAdd={onAdd || (async () => ({ ok: false, error: 'Device actions are unavailable.' }))}
      />
    </section>
  );
});

// Keep the per-device click closure behind this memo boundary. A new list can
// insert, remove, or update a row without rerendering all its unchanged peers.
const DeviceRow = memo(function DeviceRow({
  device,
  offline,
  usedByAgent,
  selected,
  onSelect,
}: {
  device: Device;
  offline: boolean;
  usedByAgent: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <DeviceListItem
      name={device.name}
      version={device.version}
      unsupported={!device.supported}
      offline={offline && !device.startup}
      statusLabel={device.startup ? deviceStartupLabel(device.startup) : undefined}
      usedByAgent={usedByAgent}
      selected={selected}
      onClick={() => onSelect(device.id)}
    />
  );
});
