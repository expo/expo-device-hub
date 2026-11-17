import { useState } from "react";

import {
  DeviceListItem,
  IconButton,
  PlusIcon,
  bg,
  border,
  heading,
  radius,
  text,
  textSize,
} from "../primitives";
import { SIDEBAR_SECTION_INSET } from "./CollapsibleSection";
import { RecentDevicesModal } from "./RecentDevicesModal";
import {
  type AddDeviceOutcome,
  type AddDeviceTarget,
  type Device,
  type NewDeviceOptions,
} from "./data";

/**
 * A titled, selectable list of devices (Simulators or Emulators) with an add
 * button at the right of the title, from the dashboard design. A hairline
 * separates it from what is above, like an inspector section. Selection is
 * controlled by the parent so it can be shared across sections — only one
 * device is "open" at a time. The add button opens the
 * "Add a simulator/emulator" picker; the chosen (or newly configured) device is
 * reported via `onAdd`.
 */
export type DeviceSectionProps = {
  title: string;
  addLabel: string;
  /** Drives the add-device picker's nouns ("simulator" / "emulator"). */
  kind: "simulator" | "emulator";
  /** Shown under the heading when the list is empty. */
  emptyLabel: string;
  devices: Device[];
  /** Devices that could be added (the modal hides any already shown here). */
  recent: Device[];
  /** Installed runtimes/system images and compatible models for new devices. */
  options: NewDeviceOptions;
  agentDeviceIds?: readonly string[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Starts the existing or newly configured device selected in the modal. */
  onAdd?: (target: AddDeviceTarget) => Promise<AddDeviceOutcome>;
};

export function DeviceSection({
  title,
  addLabel,
  kind,
  emptyLabel,
  devices,
  recent,
  options,
  agentDeviceIds = [],
  selectedId,
  onSelect,
  onAdd,
}: DeviceSectionProps) {
  const [modalOpen, setModalOpen] = useState(false);

  // Don't offer devices that are already in this section's list.
  const shownIds = new Set(devices.map((device) => device.id));
  const candidates = recent.filter((device) => !shownIds.has(device.id));

  return (
    <section
      aria-label={title}
      style={{
        display: "grid",
        gap: 16,
        minWidth: 0,
        boxSizing: "border-box",
        padding: SIDEBAR_SECTION_INSET,
        borderTop: `0.5px solid ${border.default}`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          // The title's line box, so that the add button does not change the row's height.
          height: 20,
        }}
      >
        <span style={{ ...heading.sm, color: text.default }}>{title}</span>
        {!!onAdd && (
          <IconButton
            size={24}
            label={addLabel}
            icon={<PlusIcon size={16} strokeWidth={2} />}
            onClick={() => setModalOpen(true)}
            // The plus glyph, not the button's box, lines up with the right edge of the rows.
            style={{ marginRight: -4 }}
          />
        )}
      </div>

      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        {devices.length === 0 ? (
          <p
            style={{
              ...textSize.sm,
              color: text.secondary,
              margin: 0,
              padding: "7px 8px",
              borderRadius: radius.lg,
              border: `1px dashed ${border.default}`,
              backgroundColor: bg.default,
            }}
          >
            {emptyLabel}
          </p>
        ) : (
          devices.map((device) => (
            <DeviceListItem
              key={device.id}
              name={device.name}
              version={device.version}
              platform={device.platform}
              unsupported={!device.supported}
              usedByAgent={agentDeviceIds.includes(device.id)}
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
        onAdd={onAdd || (async () => ({ ok: false, error: "Device actions are unavailable." }))}
      />
    </section>
  );
}
