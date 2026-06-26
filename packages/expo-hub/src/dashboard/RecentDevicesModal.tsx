import { useEffect, useState } from 'react';

import { Button } from '../../components/Button';
import { DeviceListItem } from '../../components/DeviceListItem';
import {
  DialogContent,
  DialogContentContainer,
  DialogFooter,
  DialogRoot,
  DialogTitle,
} from '../../components/Dialog';
import { bg, border, radius, text, textSize } from '../../theme/tokens';
import { type Device } from './data';

/**
 * "Recent Simulators" / "Recent Emulators" picker. Lists the devices that exist
 * but aren't in the sidebar yet (name + OS version), lets the user select one,
 * and adds it on confirm — one device at a time. Mirrors the website's
 * select-one-from-a-list dialog (e.g. the "Invite a member" role picker): a
 * scrollable selectable body plus a footer submit.
 */
export type RecentDevicesModalProps = {
  open: boolean;
  onClose: () => void;
  /** Header text, e.g. "Recent Simulators". */
  title: string;
  /** Candidate devices to add (already filtered to those not shown in the sidebar). */
  devices: Device[];
  /** Called with the chosen device when the user confirms. */
  onAdd: (device: Device) => void;
};

export function RecentDevicesModal({
  open,
  onClose,
  title,
  devices,
  onAdd,
}: RecentDevicesModalProps) {
  const [selectedId, setSelectedId] = useState('');

  // Start each time with nothing selected.
  useEffect(() => {
    if (open) setSelectedId('');
  }, [open]);

  const selected = devices.find((device) => device.id === selectedId);

  function handleAdd() {
    if (!selected) return;
    onAdd(selected);
    onClose();
  }

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}>
      <DialogContent>
        <DialogTitle title={title} />
        <DialogContentContainer>
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
              No other devices found — everything available is already in the list.
            </p>
          ) : (
            devices.map((device) => (
              <DeviceListItem
                key={device.id}
                name={device.name}
                version={device.version}
                selected={device.id === selectedId}
                onClick={() => setSelectedId(device.id)}
              />
            ))
          )}
        </DialogContentContainer>
        <DialogFooter>
          <Button theme="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button theme="primary" disabled={!selected} onClick={handleAdd}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
