import { type DeviceStreamMode } from '@expo/hub-client';
import { useId, useState } from 'react';

import { bg, border, radius, text, textSize } from '../primitives';

export interface StreamSettingsProps {
  mode: DeviceStreamMode;
  onModeChange: (mode: DeviceStreamMode) => void;
  secureModesAvailable: boolean;
}

/** Playback transport selector for the iOS stream in the right sidebar. */
export function StreamSettingsSection({
  mode,
  onModeChange,
  secureModesAvailable,
}: StreamSettingsProps) {
  const selectId = useId();
  const descriptionId = useId();
  const [focused, setFocused] = useState(false);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label
        htmlFor={selectId}
        style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>
        Stream
      </label>
      <select
        id={selectId}
        aria-describedby={!secureModesAvailable ? descriptionId : undefined}
        value={mode}
        onChange={(event) => onModeChange(event.target.value as DeviceStreamMode)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          ...textSize.base,
          width: '100%',
          minHeight: 44,
          padding: '8px 12px',
          color: text.default,
          backgroundColor: bg.default,
          border: `1px solid ${focused ? border.info : border.default}`,
          borderRadius: radius.md,
          boxShadow: focused ? `0 0 0 3px ${bg.info}` : 'none',
          outline: 'none',
        }}>
        <option value="h264" disabled={!secureModesAvailable}>
          H.264
        </option>
        <option value="webrtc" disabled={!secureModesAvailable}>
          WebRTC
        </option>
        <option value="mjpeg">MJPEG</option>
      </select>
      {!secureModesAvailable && (
        <p id={descriptionId} style={{ ...textSize.xs, margin: 0, color: text.secondary }}>
          Use localhost or HTTPS to enable H.264 and WebRTC.
        </p>
      )}
    </section>
  );
}
