import { type DeviceStreamMode } from '@expo/hub-client';
import { useId } from 'react';

import { bg, border, radius, text, textSize } from '../primitives';

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
  const selectId = useId();
  const helpId = useId();
  const restricted = !availability.h264 || !availability.webrtc;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>Stream</span>
      <label
        htmlFor={selectId}
        style={{ display: 'flex', flexDirection: 'column', gap: 6, color: text.secondary }}>
        <span style={{ ...textSize.xs }}>Mode</span>
        <select
          id={selectId}
          aria-describedby={restricted ? helpId : undefined}
          value={mode}
          onChange={(event) => onChange(event.currentTarget.value as DeviceStreamMode)}
          style={{
            width: '100%',
            minHeight: 44,
            boxSizing: 'border-box',
            padding: '8px 12px',
            border: `1px solid ${border.default}`,
            borderRadius: radius.lg,
            backgroundColor: bg.default,
            color: text.default,
            fontFamily: 'inherit',
            fontSize: 16,
            lineHeight: 1.4,
            cursor: 'pointer',
            touchAction: 'manipulation',
          }}>
          {STREAM_OPTIONS.map((option) => (
            <option key={option.value} value={option.value} disabled={!availability[option.value]}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {restricted && (
        <span id={helpId} style={{ ...textSize.xs, color: text.tertiary }}>
          H.264 and WebRTC require localhost or HTTPS. MJPEG is used on insecure HTTP.
        </span>
      )}
    </section>
  );
}
