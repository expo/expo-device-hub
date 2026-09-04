import { useState } from 'react';

import { type ConnectionStatus } from '@expo/hub-client';
import { bg, border, Button, font, icon, radius, text, textSize } from '../primitives';
import { type Device } from './data';

export type DeviceTitleProps = {
  device: Pick<Device, 'id' | 'name'>;
  status: ConnectionStatus;
};

const STATUS_APPEARANCE: Record<
  ConnectionStatus,
  { label: string; dotColor: string; ringColor: string; labelColor: string }
> = {
  idle: {
    label: 'Offline',
    dotColor: icon.danger,
    ringColor: border.danger,
    labelColor: text.secondary,
  },
  connecting: {
    label: 'Starting',
    dotColor: icon.warning,
    ringColor: border.warning,
    labelColor: text.secondary,
  },
  streaming: {
    label: 'Live',
    dotColor: text.success,
    ringColor: border.success,
    labelColor: text.success,
  },
  error: {
    label: 'Error',
    dotColor: icon.danger,
    ringColor: border.danger,
    labelColor: text.secondary,
  },
};

/** Compact stream-status pill that toggles between a device's name and identifier. */
export function DeviceTitle({ device, status }: DeviceTitleProps) {
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const showingId = revealedId === device.id;
  const label = showingId ? device.id : device.name;
  const appearance = STATUS_APPEARANCE[status];

  return (
    <Button
      theme="tertiary"
      size="xs"
      onClick={() => setRevealedId(showingId ? null : device.id)}
      leftSlot={
        <span
          title={label}
          style={{
            display: 'block',
            flex: '1 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: showingId ? font.mono : font.sans,
          }}>
          {label}
        </span>
      }
      rightSlot={
        <>
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              boxSizing: 'content-box',
              border: `2px solid ${appearance.ringColor}`,
              borderRadius: radius.full,
              backgroundColor: appearance.dotColor,
            }}
          />
          <span aria-live="polite" style={{ flexShrink: 0, color: appearance.labelColor }}>
            {appearance.label}
          </span>
        </>
      }
      style={{
        maxWidth: 'min(100%, 320px)',
        minWidth: 0,
        flexShrink: 0,
        boxSizing: 'border-box',
        gap: 6,
        paddingInline: 12,
        borderWidth: 0.5,
        borderColor: border.default,
        borderRadius: radius.full,
        fontSize: textSize.sm.fontSize,
        fontWeight: 600,
        // Sits on the gray stream canvas, so it takes the sidebar surface color.
        backgroundColor: bg.default,
      }}
    />
  );
}
