import { type DeviceStreamMode, type DeviceWebRtcCodec } from '@expo/hub-client';
import { useId } from 'react';

import { SegmentedControl } from '../components/SegmentedControl';
import { text, textSize } from '../primitives';
import { SidebarRow } from './SidebarRow';

export type StreamModeAvailability = Record<DeviceStreamMode, boolean>;

const STREAM_OPTIONS: Array<{ value: DeviceStreamMode; label: string }> = [
  { value: 'mjpeg', label: 'MJPEG' },
  { value: 'h264', label: 'H.264' },
  { value: 'webrtc', label: 'WebRTC' },
];

const WEBRTC_CODEC_OPTIONS: Array<{ value: DeviceWebRtcCodec; label: string }> = [
  { value: 'h264', label: 'H.264' },
  { value: 'vp9', label: 'VP9' },
  { value: 'vp8', label: 'VP8' },
];

/** Viewer-local stream transport control for the right dashboard sidebar. */
export function StreamSection({
  mode,
  availability,
  onChange,
  webRtcCodec,
  onWebRtcCodecChange,
}: {
  mode: DeviceStreamMode;
  availability: StreamModeAvailability;
  onChange: (mode: DeviceStreamMode) => void;
  webRtcCodec?: DeviceWebRtcCodec | null;
  onWebRtcCodecChange?: (codec: DeviceWebRtcCodec) => void;
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
        <SegmentedControl
          ariaLabel="Stream mode"
          ariaDescribedBy={restricted ? helpId : undefined}
          options={options}
          value={mode}
          onChange={onChange}
        />
      </SidebarRow>
      {mode === 'webrtc' && webRtcCodec && onWebRtcCodecChange && (
        <SidebarRow label="WebRTC codec">
          <SegmentedControl
            ariaLabel="WebRTC codec"
            options={WEBRTC_CODEC_OPTIONS}
            value={webRtcCodec}
            onChange={onWebRtcCodecChange}
          />
        </SidebarRow>
      )}
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
