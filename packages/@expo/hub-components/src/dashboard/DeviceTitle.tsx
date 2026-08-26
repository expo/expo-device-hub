import { useState } from 'react';

import { type ConnectionStatus } from '@expo/hub-client';
import { Button, font, icon, radius, text } from '../primitives';
import { type Device } from './data';

export type DeviceTitleProps = {
  device: Pick<Device, 'id' | 'name'>;
  status: ConnectionStatus;
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: 'Offline',
  connecting: 'Connecting',
  streaming: 'Live',
  error: 'Error',
};

/** Compact stream-status pill that toggles between a device's name and identifier. */
export function DeviceTitle({ device, status }: DeviceTitleProps) {
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const showingId = revealedId === device.id;
  const label = showingId ? device.id : device.name;
  const live = status === 'streaming';

  return (
    <Button
      theme="secondary"
      size="2xs"
      onClick={() => setRevealedId(showingId ? null : device.id)}
      style={{ maxWidth: '100%', borderRadius: radius.full }}>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
        }}>
        <span
          title={label}
          style={{
            display: 'block',
            maxWidth: 'min(65vw, 420px)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontFamily: showingId ? font.mono : font.sans,
          }}>
          {label}
        </span>
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            flexShrink: 0,
            borderRadius: radius.full,
            backgroundColor: live ? icon.success : icon.danger,
          }}
        />
        <span aria-live="polite" style={{ flexShrink: 0, color: text.secondary }}>
          {STATUS_LABEL[status]}
        </span>
      </span>
    </Button>
  );
}
