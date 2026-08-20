import { useState } from 'react';

import { Button, font, heading } from '../primitives';
import { type Device } from './data';

export type DeviceTitleProps = {
  device: Pick<Device, 'id' | 'name'>;
};

/** Clickable stream title that toggles between a device's name and identifier. */
export function DeviceTitle({ device }: DeviceTitleProps) {
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const showingId = revealedId === device.id;
  const label = showingId ? device.id : device.name;

  return (
    <Button
      theme="quaternary"
      size="2xs"
      onClick={() => setRevealedId(showingId ? null : device.id)}
      style={{ ...heading.sm, maxWidth: '100%' }}>
      <span
        title={label}
        style={{
          display: 'block',
          maxWidth: 'min(70vw, 480px)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontFamily: showingId ? font.mono : font.sans,
        }}>
        {label}
      </span>
    </Button>
  );
}
