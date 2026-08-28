import { useState } from 'react';

import {
  type DeviceClient,
  type DeviceHttpCodec,
  type DeviceStreamCapabilities,
  type DeviceStreamEncoderSettings,
  type DeviceStreamMode,
  type DeviceWebRtcCodec,
} from '@expo/hub-client';
import {
  SegmentedControl,
  Select,
  type SelectOption,
  bg,
  border,
  radius,
  text,
  textSize,
} from '../primitives';
import { CollapsibleSection } from './CollapsibleSection';
import {
  MetricChart,
  type MetricChartSeries,
  maxChartValue,
} from './MetricChart';
import { SidebarRow } from './SidebarRow';
import { type StreamModeAvailability } from './StreamSection';

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

const MAX_STATS_SAMPLES = 60;
const UNAVAILABLE_VALUE = '—';

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

function formatFps(value: number | null) {
  if (value === null || !Number.isFinite(value)) return UNAVAILABLE_VALUE;
  const safeValue = Math.max(0, value);
  return `${safeValue < 10 ? safeValue.toFixed(1) : safeValue.toFixed(0)} FPS`;
}

function formatBitrate(value: number | null) {
  if (value === null || !Number.isFinite(value)) return UNAVAILABLE_VALUE;
  const safeValue = Math.max(0, value);
  if (safeValue < 1_000_000) return `${(safeValue / 1_000).toFixed(0)} kbps`;
  return `${(safeValue / 1_000_000).toFixed(2)} Mbps`;
}

function StreamStatisticRow({ label, value }: { label: string; value: string }) {
  return (
    <tr style={{ borderTop: `1px solid ${border.secondary}` }}>
      <th
        scope="row"
        style={{
          ...textSize.xs,
          padding: '6px 8px',
          color: text.secondary,
          fontWeight: 400,
          textAlign: 'left',
        }}
      >
        {label}
      </th>
      <td
        style={{
          ...textSize.xs,
          padding: '6px 8px',
          color: text.default,
          fontWeight: 500,
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'right',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </td>
    </tr>
  );
}

function StreamStatistics({ stats }: { stats: DeviceClient['streamStats'] }) {
  const samples = stats?.samples.slice(-MAX_STATS_SAMPLES) ?? [];
  const latest = samples.at(-1) ?? null;
  const hasClientMeasurement = samples.some(
    (sample) => sample.clientFps !== null || sample.clientBitrateBps !== null,
  );
  const clientFpsSeries: MetricChartSeries[] = [
    {
      label: 'Client FPS',
      color: text.info,
      values: samples.flatMap((sample) =>
        sample.clientFps === null ? [] : [sample.clientFps],
      ),
    },
  ];
  const clientBitrateSeries: MetricChartSeries[] = [
    {
      label: 'Client bitrate',
      color: text.preview,
      values: samples.flatMap((sample) =>
        sample.clientBitrateBps === null ? [] : [sample.clientBitrateBps],
      ),
    },
  ];

  const message = stats?.stale
    ? 'Stream statistics are paused. Showing the most recent samples.'
    : hasClientMeasurement
      ? null
      : 'Measuring WebRTC stream…';

  return (
    <div
      style={{
        display: 'flex',
        minWidth: 0,
        flexDirection: 'column',
        gap: 8,
        paddingTop: 8,
      }}
    >
      {message && (
        <span role="status" style={{ ...textSize.xs, color: text.tertiary }}>
          {message}
        </span>
      )}
      <table
        aria-label="WebRTC stream statistics"
        style={{
          width: '100%',
          tableLayout: 'fixed',
          borderCollapse: 'separate',
          borderSpacing: 0,
          overflow: 'hidden',
          border: `1px solid ${border.secondary}`,
          borderRadius: radius.md,
          backgroundColor: bg.subtle,
        }}
      >
        <thead>
          <tr>
            <th
              scope="col"
              style={{
                ...textSize['2xs'],
                padding: '6px 8px',
                color: text.tertiary,
                fontWeight: 500,
                textAlign: 'left',
              }}
            >
              Metric
            </th>
            <th
              scope="col"
              style={{
                ...textSize['2xs'],
                padding: '6px 8px',
                color: text.tertiary,
                fontWeight: 500,
                textAlign: 'right',
              }}
            >
              Current
            </th>
          </tr>
        </thead>
        <tbody>
          <StreamStatisticRow label="Server FPS" value={formatFps(latest?.serverFps ?? null)} />
          <StreamStatisticRow label="Client FPS" value={formatFps(latest?.clientFps ?? null)} />
          <StreamStatisticRow
            label="Client bitrate"
            value={formatBitrate(latest?.clientBitrateBps ?? null)}
          />
        </tbody>
      </table>
      {latest && hasClientMeasurement && (
        <>
          <MetricChart
            title="Client FPS"
            value={formatFps(latest.clientFps)}
            description="Last 60 samples"
            series={clientFpsSeries}
            maxValue={maxChartValue(clientFpsSeries)}
          />
          <MetricChart
            title="Client bitrate"
            value={formatBitrate(latest.clientBitrateBps)}
            description="Last 60 samples"
            series={clientBitrateSeries}
            maxValue={maxChartValue(clientBitrateSeries)}
          />
        </>
      )}
    </div>
  );
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
  const settingsReady = client.streamSettings !== null;
  const settingsDisabled = !settingsReady || client.streamSettingsPending;
  const transport: StreamTransport =
    activeStreamMode === 'webrtc' ? 'webrtc' : primaryTransport;
  const httpAvailable = availability.mjpeg || availability.h264;

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
          borderBottom={client.capabilities.streamSettings || transport === 'webrtc'}
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
      {client.capabilities.streamSettings && (
        <>
          <SidebarRow label="Max size">
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
          <SidebarRow label="MJPEG FPS">
            <Select
              ariaLabel="MJPEG FPS"
              value={String(settings.mjpegFps)}
              options={withCurrentValue(settings.mjpegFps, FPS_OPTIONS, (value) => `${value} FPS`)}
              disabled={settingsDisabled || transport !== 'http'}
              onChange={(value) => patchSetting('mjpegFps', Number(value))}
            />
          </SidebarRow>
          <SidebarRow label="MJPEG quality">
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
          <SidebarRow label="Video FPS">
            <Select
              ariaLabel="Video FPS"
              value={String(settings.h264Fps)}
              options={withCurrentValue(settings.h264Fps, FPS_OPTIONS, (value) => `${value} FPS`)}
              disabled={settingsDisabled || !h264Active}
              onChange={(value) => patchSetting('h264Fps', Number(value))}
            />
          </SidebarRow>
          <SidebarRow label="Video bitrate" borderBottom={transport === 'webrtc'}>
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
        </>
      )}
      {transport === 'webrtc' && <StreamStatistics stats={client.streamStats} />}
    </CollapsibleSection>
  );
}
