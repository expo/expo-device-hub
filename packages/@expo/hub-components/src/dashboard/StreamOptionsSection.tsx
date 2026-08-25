import { useState } from 'react';

import {
  type DeviceClient,
  type DeviceHttpCodec,
  type DeviceStreamEncoderSettings,
  type DeviceStreamMode,
  type DeviceWebRtcCodec,
} from '@expo/hub-client';
import { SegmentedControl, bg, border, radius, text, textSize } from '../primitives';
import { CollapsibleSection } from './CollapsibleSection';
import { SidebarRow } from './SidebarRow';
import { type StreamModeAvailability } from './StreamSection';

type StreamTransport = 'http' | 'webrtc';
type SelectOption = { value: string; label: string };

export type StreamOptionsSectionProps = {
  client: DeviceClient;
  streamMode?: DeviceStreamMode;
  httpCodec?: DeviceHttpCodec;
  streamModeAvailability?: StreamModeAvailability;
  onStreamModeChange?: (mode: DeviceStreamMode) => void;
  onHttpCodecChange?: (codec: DeviceHttpCodec) => void;
};

const DEFAULT_SETTINGS: DeviceStreamEncoderSettings = {
  mjpegFps: 30,
  mjpegQuality: 0.7,
  maxDimension: 0,
  h264Bitrate: 6_000_000,
  h264Fps: 30,
};

const DEFAULT_AVAILABILITY: StreamModeAvailability = {
  mjpeg: true,
  h264: true,
  webrtc: true,
};

const TRANSPORT_OPTIONS = [
  { value: 'http', label: 'HTTP' },
  { value: 'webrtc', label: 'WebRTC' },
] as const;

const HTTP_CODEC_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'h264', label: 'H.264' },
  { value: 'mjpeg', label: 'MJPEG' },
] as const;

const WEBRTC_CODEC_OPTIONS = [
  { value: 'h264', label: 'H.264' },
  { value: 'vp9', label: 'VP9' },
  { value: 'vp8', label: 'VP8' },
] as const;

const MAX_DIMENSION_OPTIONS: SelectOption[] = [
  { value: '0', label: 'Full' },
  { value: '1920', label: '1920 px' },
  { value: '1600', label: '1600 px' },
  { value: '1280', label: '1280 px' },
  { value: '960', label: '960 px' },
  { value: '720', label: '720 px' },
];

const FPS_OPTIONS: SelectOption[] = ['60', '30', '20', '15', '10', '5'].map((value) => ({
  value,
  label: `${value} FPS`,
}));

const QUALITY_OPTIONS: SelectOption[] = [
  { value: '0.45', label: '45%' },
  { value: '0.55', label: '55%' },
  { value: '0.7', label: '70%' },
  { value: '0.85', label: '85%' },
  { value: '1', label: '100%' },
];

const BITRATE_OPTIONS: SelectOption[] = [
  { value: '1500000', label: '1.5 Mbps' },
  { value: '3000000', label: '3 Mbps' },
  { value: '6000000', label: '6 Mbps' },
  { value: '10000000', label: '10 Mbps' },
  { value: '16000000', label: '16 Mbps' },
];

function withCurrentValue(
  value: number,
  options: SelectOption[],
  label: (value: number) => string,
) {
  const current = String(value);
  return options.some((option) => option.value === current)
    ? options
    : [{ value: current, label: label(value) }, ...options];
}

function SettingSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
      style={{
        ...textSize.xs,
        minWidth: 116,
        height: 30,
        padding: '0 24px 0 9px',
        boxSizing: 'border-box',
        border: `1px solid ${border.default}`,
        borderRadius: radius.md,
        backgroundColor: bg.subtle,
        color: text.default,
        fontFamily: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Viewer transport, codec, and serve-sim runtime encoder controls. */
export function StreamOptionsSection({
  client,
  streamMode = 'mjpeg',
  httpCodec,
  streamModeAvailability = DEFAULT_AVAILABILITY,
  onStreamModeChange,
  onHttpCodecChange,
}: StreamOptionsSectionProps) {
  const [open, setOpen] = useState(false);
  const settings = client.streamSettings ?? DEFAULT_SETTINGS;
  const settingsReady = client.streamSettings !== null;
  const settingsDisabled = !settingsReady || client.streamSettingsPending;
  const transport: StreamTransport = streamMode === 'webrtc' ? 'webrtc' : 'http';
  const selectedHttpCodec: DeviceHttpCodec =
    httpCodec ?? (streamMode === 'mjpeg' ? 'mjpeg' : streamMode === 'h264' ? 'h264' : 'auto');
  const httpAvailable = streamModeAvailability.mjpeg || streamModeAvailability.h264;
  const h264Active =
    transport === 'webrtc' ||
    (transport === 'http' && streamModeAvailability.h264 && selectedHttpCodec !== 'mjpeg');

  function httpMode(codec: DeviceHttpCodec): DeviceStreamMode {
    if (codec === 'mjpeg') return 'mjpeg';
    if (codec === 'h264') return streamModeAvailability.h264 ? 'h264' : 'mjpeg';
    return streamModeAvailability.h264 ? 'h264' : 'mjpeg';
  }

  function changeTransport(nextTransport: StreamTransport) {
    onStreamModeChange?.(nextTransport === 'webrtc' ? 'webrtc' : httpMode(selectedHttpCodec));
  }

  function changeHttpCodec(codec: DeviceHttpCodec) {
    onHttpCodecChange?.(codec);
    if (transport === 'http') onStreamModeChange?.(httpMode(codec));
  }

  function patchSetting<Key extends keyof DeviceStreamEncoderSettings>(
    key: Key,
    value: DeviceStreamEncoderSettings[Key],
  ) {
    if (!settingsDisabled) client.updateStreamSettings({ [key]: value });
  }

  const restricted = !streamModeAvailability.h264 || !streamModeAvailability.webrtc;

  return (
    <CollapsibleSection title="Stream options" open={open} onOpenChange={setOpen}>
      <SidebarRow label="Transport">
        <SegmentedControl
          ariaLabel="Stream transport"
          options={TRANSPORT_OPTIONS.map((option) => ({
            ...option,
            disabled:
              !onStreamModeChange ||
              (option.value === 'http' ? !httpAvailable : !streamModeAvailability.webrtc),
          }))}
          value={transport}
          onChange={changeTransport}
        />
      </SidebarRow>
      <SidebarRow label="HTTP codec">
        <SegmentedControl
          ariaLabel="HTTP codec"
          options={HTTP_CODEC_OPTIONS.map((option) => ({
            ...option,
            disabled:
              transport !== 'http' ||
              !onHttpCodecChange ||
              (option.value === 'h264' && !streamModeAvailability.h264) ||
              (option.value === 'mjpeg' && !streamModeAvailability.mjpeg),
          }))}
          value={selectedHttpCodec}
          onChange={changeHttpCodec}
        />
      </SidebarRow>
      <SidebarRow label="WebRTC codec">
        <SegmentedControl
          ariaLabel="WebRTC codec"
          options={WEBRTC_CODEC_OPTIONS.map((option) => ({
            ...option,
            disabled: transport !== 'webrtc' || !streamModeAvailability.webrtc,
          }))}
          value={client.webRtcCodec}
          onChange={(codec: DeviceWebRtcCodec) => client.setWebRtcCodec(codec)}
        />
      </SidebarRow>
      {restricted && (
        <span
          style={{ ...textSize.xs, display: 'block', padding: '0 0 8px', color: text.tertiary }}
        >
          H.264 and WebRTC require localhost or HTTPS. MJPEG remains available on insecure HTTP.
        </span>
      )}
      <SidebarRow label="Max size">
        <SettingSelect
          label="Max size"
          value={String(settings.maxDimension)}
          options={withCurrentValue(settings.maxDimension, MAX_DIMENSION_OPTIONS, (value) =>
            value === 0 ? 'Full' : `${value} px`,
          )}
          disabled={settingsDisabled}
          onChange={(value) => patchSetting('maxDimension', Number(value))}
        />
      </SidebarRow>
      <SidebarRow label="MJPEG FPS">
        <SettingSelect
          label="MJPEG FPS"
          value={String(settings.mjpegFps)}
          options={withCurrentValue(settings.mjpegFps, FPS_OPTIONS, (value) => `${value} FPS`)}
          disabled={settingsDisabled || transport !== 'http'}
          onChange={(value) => patchSetting('mjpegFps', Number(value))}
        />
      </SidebarRow>
      <SidebarRow label="MJPEG quality">
        <SettingSelect
          label="MJPEG quality"
          value={String(settings.mjpegQuality)}
          options={withCurrentValue(
            settings.mjpegQuality,
            QUALITY_OPTIONS,
            (value) => `${Math.round(value * 100)}%`,
          )}
          disabled={settingsDisabled || transport !== 'http'}
          onChange={(value) => patchSetting('mjpegQuality', Number(value))}
        />
      </SidebarRow>
      <SidebarRow label="Video FPS">
        <SettingSelect
          label="Video FPS"
          value={String(settings.h264Fps)}
          options={withCurrentValue(settings.h264Fps, FPS_OPTIONS, (value) => `${value} FPS`)}
          disabled={settingsDisabled || !h264Active}
          onChange={(value) => patchSetting('h264Fps', Number(value))}
        />
      </SidebarRow>
      <SidebarRow label="Video bitrate" borderBottom={false}>
        <SettingSelect
          label="Video bitrate"
          value={String(settings.h264Bitrate)}
          options={withCurrentValue(
            settings.h264Bitrate,
            BITRATE_OPTIONS,
            (value) => `${value / 1_000_000} Mbps`,
          )}
          disabled={settingsDisabled || !h264Active}
          onChange={(value) => patchSetting('h264Bitrate', Number(value))}
        />
      </SidebarRow>
    </CollapsibleSection>
  );
}
