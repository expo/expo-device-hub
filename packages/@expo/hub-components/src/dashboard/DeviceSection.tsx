import { useState } from "react";

import { DeviceListItem, bg, border, heading, radius, text, textSize } from "../primitives";
import { AddDeviceMenu } from "./AddDeviceMenu";
import { BootErrorModal } from "./BootErrorModal";
import { SIDEBAR_SECTION_INSET } from "./CollapsibleSection";
import { NewDeviceModal } from "./NewDeviceModal";
import { byLastUsed } from "./new-device";
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
 * device is "open" at a time. The add button opens a menu of the recent
 * devices; a click boots one, and its last row opens the form that creates a
 * new device. Both report through `onAdd`.
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
  const [creating, setCreating] = useState(false);
  const [bootError, setBootError] = useState<{ deviceName: string; message: string } | null>(null);

  // Don't offer devices that are already in this section's list.
  const shownIds = new Set(devices.map((device) => device.id));
  const recents = byLastUsed(recent.filter((device) => !shownIds.has(device.id)));

  // The menu has no room for a failure, so a failed boot opens a dialog with the host's reason.
  async function bootRecent(device: Device) {
    if (!onAdd) return;
    let error: string | null = null;
    try {
      const outcome = await onAdd({ kind: "recent", device });
      if (!outcome.ok) error = outcome.error;
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    if (error !== null) setBootError({ deviceName: device.name, message: error });
  }

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
          <AddDeviceMenu
            label={addLabel}
            kind={kind}
            recents={recents}
            onBoot={bootRecent}
            onCreate={() => setCreating(true)}
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

      {!!onAdd && (
        <NewDeviceModal
          open={creating}
          onClose={() => setCreating(false)}
          kind={kind}
          existing={[...devices, ...recent]}
          options={options}
          onAdd={onAdd}
        />
      )}
      <BootErrorModal
        open={bootError !== null}
        onClose={() => setBootError(null)}
        deviceName={bootError?.deviceName ?? ""}
        message={bootError?.message ?? ""}
      />
    </section>
  );
}
