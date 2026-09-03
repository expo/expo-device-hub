import { useEffect, useState } from 'react';

import {
  type DeviceClient,
  type DeviceGrpcImageMode,
  type DeviceHttpCodec,
  type DeviceInputSource,
  type DeviceStreamCapabilities,
  type DeviceStreamEncoderSettings,
  type DeviceStreamMode,
  type DeviceStreamSource,
  type DeviceWebRtcCodec,
} from '@expo/hub-client';
import {
  SegmentedControl,
  Select,
  type SelectOption,
  text,
  textSize,
} from '../primitives';
import { CollapsibleSection } from './CollapsibleSection';
import { SidebarRow } from './SidebarRow';
import { type StreamModeAvailability } from './StreamSection';
import { StreamStatistics } from './StreamStatistics';

type StreamTransport = 'http' | 'websocket' | 'webrtc';

export type StreamOptionsSectionProps = {
  client: DeviceClient;
  /** Whether the section is initially expanded. */
  defaultOpen?: boolean;
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

const DEFAULT_STREAM_CAPABILITIES = {
  modeAvailability: DEFAULT_AVAILABILITY,
  httpCodecs: ['auto', 'h264', 'mjpeg'],
  webRtcCodecs: ['h264', 'vp9', 'vp8'],
} as const satisfies DeviceStreamCapabilities;

const STREAM_MODE_ORDER: readonly DeviceStreamMode[] = ['mjpeg', 'h264', 'webrtc'];
const STREAM_SOURCE_OPTIONS: ReadonlyArray<{ value: DeviceStreamSource; label: string }> = [
  { value: 'scrcpy', label: 'scrcpy' },
  { value: 'grpc-screenshot', label: 'gRPC' },
];
const GRPC_IMAGE_MODE_OPTIONS: ReadonlyArray<{
  value: DeviceGrpcImageMode;
  label: string;
}> = [
  { value: 'png', label: 'PNG' },
  { value: 'mmap', label: 'MMAP' },
];
const GRPC_INPUT_SOURCE_OPTIONS: ReadonlyArray<{
  value: DeviceInputSource;
  label: string;
}> = [
  { value: 'scrcpy', label: 'scrcpy' },
  { value: 'grpc', label: 'gRPC' },
];
const STREAM_SETTING_ORDER: readonly (keyof DeviceStreamEncoderSettings)[] = [
  'maxDimension',
  'mjpegFps',
  'mjpegQuality',
  'h264Fps',
  'h264Bitrate',
];

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


/** Viewer transport, backend-supported codecs, and optional runtime encoder controls. */
export function StreamOptionsSection({
  client,
  defaultOpen = false,
  streamMode = 'mjpeg',
  httpCodec,
  streamModeAvailability = DEFAULT_AVAILABILITY,
  onStreamModeChange,
  onHttpCodecChange,
}: StreamOptionsSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const backend: DeviceStreamCapabilities =
    client.streamCapabilities ?? DEFAULT_STREAM_CAPABILITIES;
  const availability: StreamModeAvailability = {
    mjpeg: streamModeAvailability.mjpeg && backend.modeAvailability.mjpeg,
    h264: streamModeAvailability.h264 && backend.modeAvailability.h264,
    webrtc: streamModeAvailability.webrtc && backend.modeAvailability.webrtc,
  };
  const activeStreamMode = availability[streamMode]
    ? streamMode
    : (STREAM_MODE_ORDER.find((mode) => availability[mode]) ?? streamMode);
  const primaryTransport: Exclude<StreamTransport, 'webrtc'> =
    client.platform === 'android' ? 'websocket' : 'http';
  const primaryTransportLabel = client.platform === 'android' ? 'WebSocket' : 'HTTP';
  const transportOptions: ReadonlyArray<{ value: StreamTransport; label: string }> = [
    { value: primaryTransport, label: primaryTransportLabel },
    { value: 'webrtc', label: 'WebRTC' },
  ];
  const httpCodecOptions = HTTP_CODEC_OPTIONS.filter((option) =>
    backend.httpCodecs.includes(option.value),
  );
  const webRtcCodecOptions = WEBRTC_CODEC_OPTIONS.filter((option) =>
    backend.webRtcCodecs.includes(option.value),
  );
  const settings = client.streamSettings ?? DEFAULT_SETTINGS;
  const settingsCapabilities = client.capabilities.streamSettings;
  const supportedSettingKeys = settingsCapabilities
    ? STREAM_SETTING_ORDER.filter((key) => settingsCapabilities[key])
    : [];
  const finalSettingKey = supportedSettingKeys.at(-1);
  const streamSource = client.streamSource;
  const sourceOptions = STREAM_SOURCE_OPTIONS.filter((option) =>
    streamSource?.availableModes.includes(option.value),
  );
  const inputSourceOptions = GRPC_INPUT_SOURCE_OPTIONS.filter((option) =>
    streamSource?.availableInputSources.includes(option.value),
  );
  const settingsReady = client.streamSettings !== null;
  const settingsDisabled = !settingsReady || client.streamSettingsPending;
  const transport: StreamTransport =
    activeStreamMode === 'webrtc' ? 'webrtc' : primaryTransport;
  const setStreamStatsEnabled = client.setStreamStatsEnabled;
  const httpAvailable = availability.mjpeg || availability.h264;

  useEffect(() => {
    setStreamStatsEnabled(open && transport === 'webrtc');
    return () => setStreamStatsEnabled(false);
  }, [open, setStreamStatsEnabled, transport]);

  function httpCodecAvailable(codec: DeviceHttpCodec): boolean {
    if (codec === 'h264') return availability.h264;
    if (codec === 'mjpeg') return availability.mjpeg;
    return httpAvailable;
  }

  const requestedHttpCodec: DeviceHttpCodec =
    httpCodec ??
    (activeStreamMode === 'mjpeg' ? 'mjpeg' : activeStreamMode === 'h264' ? 'h264' : 'auto');
  const modeHttpCodec =
    activeStreamMode === 'mjpeg' || activeStreamMode === 'h264' ? activeStreamMode : null;
  const fallbackHttpCodec =
    (modeHttpCodec &&
    backend.httpCodecs.includes(modeHttpCodec) &&
    httpCodecAvailable(modeHttpCodec)
      ? modeHttpCodec
      : undefined) ?? httpCodecOptions.find((option) => httpCodecAvailable(option.value))?.value;
  const selectedHttpCodec: DeviceHttpCodec =
    backend.httpCodecs.includes(requestedHttpCodec) && httpCodecAvailable(requestedHttpCodec)
      ? requestedHttpCodec
      : (fallbackHttpCodec ?? requestedHttpCodec);
  const selectedWebRtcCodec = backend.webRtcCodecs.includes(client.webRtcCodec)
    ? client.webRtcCodec
    : (webRtcCodecOptions[0]?.value ?? client.webRtcCodec);
  const h264Active =
    transport === 'webrtc' ||
    (availability.h264 && selectedHttpCodec !== 'mjpeg');

  function httpMode(codec: DeviceHttpCodec): DeviceStreamMode {
    if (codec === 'mjpeg') return 'mjpeg';
    if (codec === 'h264') return availability.h264 ? 'h264' : 'mjpeg';
    return availability.h264 ? 'h264' : 'mjpeg';
  }

  function changeTransport(nextTransport: StreamTransport) {
    onStreamModeChange?.(nextTransport === 'webrtc' ? 'webrtc' : httpMode(selectedHttpCodec));
  }

  function changeHttpCodec(codec: DeviceHttpCodec) {
    onHttpCodecChange?.(codec);
    if (transport !== 'webrtc') onStreamModeChange?.(httpMode(codec));
  }

  function patchSetting<Key extends keyof DeviceStreamEncoderSettings>(
    key: Key,
    value: DeviceStreamEncoderSettings[Key],
  ) {
    if (!settingsDisabled) client.updateStreamSettings({ [key]: value });
  }

  const restricted =
    (backend.modeAvailability.h264 && !streamModeAvailability.h264) ||
    (backend.modeAvailability.webrtc && !streamModeAvailability.webrtc);
  const hostWebRtcDisabled =
    client.platform === 'android' && !backend.modeAvailability.webrtc;

  return (
    <CollapsibleSection title="Stream options" open={open} onOpenChange={setOpen}>
      {streamSource && sourceOptions.length > 1 && (
        <>
          <SidebarRow label="Source">
            <SegmentedControl
              ariaLabel="Stream source"
              options={sourceOptions.map((option) => ({
                ...option,
                disabled: client.streamSourcePending,
              }))}
              value={streamSource.mode}
              onChange={client.setStreamSource}
            />
          </SidebarRow>
          {client.streamSourceError && (
            <span
              role="alert"
              style={{
                ...textSize.xs,
                display: 'block',
                padding: '0 0 8px',
                color: text.danger,
              }}
            >
              {client.streamSourceError}
            </span>
          )}
        </>
      )}
      {streamSource?.mode === 'grpc-screenshot' && (
        <>
          {inputSourceOptions.length > 1 && (
            <SidebarRow label="Input">
              <SegmentedControl
                ariaLabel="Input source"
                options={inputSourceOptions.map((option) => ({
                  ...option,
                  disabled: client.streamSourcePending,
                }))}
                value={streamSource.inputSource}
                onChange={client.setGrpcInputSource}
              />
            </SidebarRow>
          )}
          <SidebarRow label="gRPC frames">
            <SegmentedControl
              ariaLabel="gRPC image mode"
              options={GRPC_IMAGE_MODE_OPTIONS.map((option) => ({
                ...option,
                disabled: client.streamSourcePending,
              }))}
              value={streamSource.grpcImageMode}
              onChange={client.setGrpcImageMode}
            />
          </SidebarRow>
        </>
      )}
      <SidebarRow label="Transport">
        <SegmentedControl
          ariaLabel="Stream transport"
          options={transportOptions.map((option) => ({
            ...option,
            disabled:
              !onStreamModeChange ||
              (option.value === 'webrtc' ? !availability.webrtc : !httpAvailable),
          }))}
          value={transport}
          onChange={changeTransport}
        />
      </SidebarRow>
      {httpCodecOptions.length > 0 && (
        <SidebarRow label={`${primaryTransportLabel} codec`}>
          <SegmentedControl
            ariaLabel={`${primaryTransportLabel} codec`}
            options={httpCodecOptions.map((option) => ({
              ...option,
              disabled:
                transport === 'webrtc' || !onHttpCodecChange || !httpCodecAvailable(option.value),
            }))}
            value={selectedHttpCodec}
            onChange={changeHttpCodec}
          />
        </SidebarRow>
      )}
      {webRtcCodecOptions.length > 0 && (
        <SidebarRow
          label="WebRTC codec"
          borderBottom={supportedSettingKeys.length > 0 || transport === 'webrtc'}
        >
          <SegmentedControl
            ariaLabel="WebRTC codec"
            options={webRtcCodecOptions.map((option) => ({
              ...option,
              disabled: transport !== 'webrtc' || !availability.webrtc,
            }))}
            value={selectedWebRtcCodec}
            onChange={(codec: DeviceWebRtcCodec) => client.setWebRtcCodec(codec)}
          />
        </SidebarRow>
      )}
      {restricted && (
        <span
          style={{ ...textSize.xs, display: 'block', padding: '0 0 8px', color: text.tertiary }}
        >
          {client.platform === 'android'
            ? 'WebRTC requires localhost or HTTPS.'
            : 'H.264 and WebRTC require localhost or HTTPS. MJPEG remains available on insecure HTTP.'}
        </span>
      )}
      {hostWebRtcDisabled && (
        <span
          style={{ ...textSize.xs, display: 'block', padding: '0 0 8px', color: text.tertiary }}
        >
          Start the standalone server with --transport webrtc to enable WebRTC.
        </span>
      )}
      {settingsCapabilities && (
        <>
          {settingsCapabilities.maxDimension && (
            <SidebarRow label="Max size" borderBottom={finalSettingKey !== 'maxDimension'}>
              <Select
                ariaLabel="Max size"
                value={String(settings.maxDimension)}
                options={withCurrentValue(settings.maxDimension, MAX_DIMENSION_OPTIONS, (value) =>
                  value === 0 ? 'Full' : `${value} px`,
                )}
                disabled={settingsDisabled}
                onChange={(value) => patchSetting('maxDimension', Number(value))}
              />
            </SidebarRow>
          )}
          {settingsCapabilities.mjpegFps && (
            <SidebarRow label="MJPEG FPS" borderBottom={finalSettingKey !== 'mjpegFps'}>
              <Select
                ariaLabel="MJPEG FPS"
                value={String(settings.mjpegFps)}
                options={withCurrentValue(settings.mjpegFps, FPS_OPTIONS, (value) => `${value} FPS`)}
                disabled={settingsDisabled || transport !== 'http'}
                onChange={(value) => patchSetting('mjpegFps', Number(value))}
              />
            </SidebarRow>
          )}
          {settingsCapabilities.mjpegQuality && (
            <SidebarRow label="MJPEG quality" borderBottom={finalSettingKey !== 'mjpegQuality'}>
              <Select
                ariaLabel="MJPEG quality"
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
          )}
          {settingsCapabilities.h264Fps && (
            <SidebarRow label="Video FPS" borderBottom={finalSettingKey !== 'h264Fps'}>
              <Select
                ariaLabel="Video FPS"
                value={String(settings.h264Fps)}
                options={withCurrentValue(settings.h264Fps, FPS_OPTIONS, (value) => `${value} FPS`)}
                disabled={settingsDisabled || !h264Active}
                onChange={(value) => patchSetting('h264Fps', Number(value))}
              />
            </SidebarRow>
          )}
          {settingsCapabilities.h264Bitrate && (
            <SidebarRow
              label="Video bitrate"
              borderBottom={finalSettingKey !== 'h264Bitrate' || transport === 'webrtc'}
            >
              <Select
                ariaLabel="Video bitrate"
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
          )}
        </>
      )}
      {transport === 'webrtc' && (
        <StreamStatistics stats={client.streamStats} platform={client.platform} />
      )}
    </CollapsibleSection>
  );
}
