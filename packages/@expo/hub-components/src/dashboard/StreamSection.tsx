import { type DeviceStreamMode } from '@expo/hub-client';
import { useId } from 'react';

import { Select } from '../components/Select';
import { text, textSize } from '../primitives';
import { SidebarRow } from './SidebarRow';

export type StreamModeAvailability = Record<DeviceStreamMode, boolean>;

const STREAM_OPTIONS: Array<{ value: DeviceStreamMode; label: string }> = [
  { value: 'mjpeg', label: 'MJPEG' },
  { value: 'h264', label: 'H.264' },
  { value: 'webrtc', label: 'WebRTC' },
];

/** Viewer-local stream transport control for the right dashboard sidebar. */
export function StreamSection({
  mode,
  availability,
  onChange,
}: {
  mode: DeviceStreamMode;
  availability: StreamModeAvailability;
  onChange: (mode: DeviceStreamMode) => void;
}) {
  const helpId = useId();
  const restricted = !availability.h264 || !availability.webrtc;
  const options = STREAM_OPTIONS.map((option) => ({
    ...option,
    disabled: !availability[option.value],
  }));

  return (
    <>
      <SidebarRow label="Stream">
        <Select
          ariaLabel="Stream mode"
          ariaDescribedBy={restricted ? helpId : undefined}
          options={options}
          value={mode}
          onChange={onChange}
        />
      </SidebarRow>
      {restricted && (
        <span
          id={helpId}
          style={{ ...textSize.xs, display: 'block', padding: '0 0 11px', color: text.tertiary }}>
          H.264 and WebRTC require localhost or HTTPS. MJPEG is used on insecure HTTP.
        </span>
      )}
    </>
  );
}
