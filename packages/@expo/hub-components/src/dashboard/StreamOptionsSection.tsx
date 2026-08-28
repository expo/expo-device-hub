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

const MAX_STATS_SAMPLES = 60;
const UNAVAILABLE_VALUE = '—';
const COMPACT_STATS_COLUMNS = 'repeat(auto-fit, minmax(150px, 1fr))';

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

function formatPercentage(value: number | null) {
  if (value === null || !Number.isFinite(value)) return UNAVAILABLE_VALUE;
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}

function formatMilliseconds(value: number | null, digits: number) {
  if (value === null || !Number.isFinite(value)) return UNAVAILABLE_VALUE;
  return `${Math.max(0, value).toFixed(digits)} ms`;
}

function formatCount(value: number | null) {
  if (value === null || !Number.isFinite(value)) return UNAVAILABLE_VALUE;
  const safeValue = Math.max(0, value);
  if (safeValue < 1_000) return String(Math.round(safeValue));
  if (safeValue < 999_950) return `${(safeValue / 1_000).toFixed(1)}k`;
  return `${(safeValue / 1_000_000).toFixed(2)}M`;
}

function formatFreezes(count: number | null, durationMs: number | null) {
  const countValue = formatCount(count);
  if (
    count === null ||
    !Number.isFinite(count) ||
    count <= 0 ||
    durationMs === null ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return countValue;
  }
  const safeDurationMs = Math.max(0, durationMs);
  const duration =
    safeDurationMs < 1_000
      ? `${safeDurationMs.toFixed(0)} ms`
      : `${(safeDurationMs / 1_000).toFixed(1)} s`;
  return `${countValue} · ${duration}`;
}

function formatIcePath(value: 'direct' | 'relay' | 'unknown' | null | undefined) {
  if (value === 'direct') return 'Direct';
  if (value === 'relay') return 'Via relay';
  return UNAVAILABLE_VALUE;
}

function formatCodec(value: string | null) {
  if (value === null || value.length === 0) return UNAVAILABLE_VALUE;
  const codec = value.replace(/^video\//i, '');
  if (/^h\.?264$/i.test(codec)) return 'H.264';
  if (/^vp8$/i.test(codec)) return 'VP8';
  if (/^vp9$/i.test(codec)) return 'VP9';
  if (/^av1$/i.test(codec)) return 'AV1';
  return codec;
}

function formatEncoderLimitation(value: string | null) {
  switch (value) {
    case 'none':
      return 'None';
    case 'cpu':
      return 'CPU';
    case 'bandwidth':
      return 'Network';
    case null:
      return UNAVAILABLE_VALUE;
    default:
      return 'Unknown';
  }
}

function StreamStatisticGroupHeading({ label }: { label: string }) {
  return (
    <div role="row" style={{ gridColumn: '1 / -1' }}>
      <span
        role="columnheader"
        aria-colspan={2}
        style={{
          ...textSize['2xs'],
          display: 'block',
          padding: '7px 8px 5px',
          borderTop: `1px solid ${border.secondary}`,
          color: text.secondary,
          fontWeight: 500,
          letterSpacing: '0.04em',
          textAlign: 'left',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
    </div>
  );
}

function StreamStatisticRow({
  label,
  value,
  stale = false,
}: {
  label: string;
  value: string;
  stale?: boolean;
}) {
  return (
    <div
      role="row"
      data-stream-statistic={label}
      style={{
        display: 'flex',
        minWidth: 0,
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 4,
        padding: '5px 8px',
        borderTop: `1px solid ${border.secondary}`,
        opacity: stale ? 0.55 : 1,
      }}
    >
      <span
        role="rowheader"
        style={{
          ...textSize['2xs'],
          minWidth: 0,
          color: text.secondary,
          fontWeight: 400,
        }}
      >
        {label}
      </span>
      <span
        role="cell"
        style={{
          ...textSize['2xs'],
          flexShrink: 0,
          color: text.default,
          fontWeight: 500,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function StreamStatistics({
  stats,
  platform,
}: {
  stats: DeviceClient['streamStats'];
  platform: DeviceClient['platform'];
}) {
  const samples = stats?.samples.slice(-MAX_STATS_SAMPLES) ?? [];
  const latest = samples.at(-1) ?? null;
  const encoder = stats?.encoder ?? null;
  const capture = stats?.capture ?? null;
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

  const pausedMessage =
    stats?.stale && stats.serverStale
      ? 'Client and server stream statistics are paused. Showing the most recent samples.'
      : stats?.stale
        ? 'Client stream statistics are paused. Showing the most recent samples.'
        : stats?.serverStale
          ? 'Server stream statistics are paused. Showing the most recent values.'
          : null;
  const measuring = !hasClientMeasurement && !stats?.stale;
  const encoderRows =
    encoder === null
      ? []
      : platform === 'android'
        ? [
            { label: 'Codec', value: formatCodec(encoder.codec) },
            {
              label: 'Output FPS',
              value: formatFps(encoder.encodeFps),
            },
            {
              label: 'Configured bitrate',
              value: formatBitrate(encoder.targetBitrateBps),
            },
            {
              label: 'Output frames',
              value: formatCount(encoder.framesEncoded),
            },
          ]
        : [
            { label: 'Codec', value: formatCodec(encoder.codec) },
            { label: 'Encode FPS', value: formatFps(encoder.encodeFps) },
            { label: 'Target bitrate', value: formatBitrate(encoder.targetBitrateBps) },
            {
              label: 'Encode time / frame',
              value: formatMilliseconds(encoder.encodeMsPerFrame, 1),
            },
            { label: 'Frames encoded', value: formatCount(encoder.framesEncoded) },
            { label: 'Frames sent', value: formatCount(encoder.framesSent) },
            { label: 'Frames dropped', value: formatCount(encoder.framesDropped) },
            { label: 'Packet loss', value: formatPercentage(encoder.packetLossRatio) },
            {
              label: 'Limitation',
              value: formatEncoderLimitation(encoder.qualityLimitationReason),
            },
          ];
  const captureRows =
    capture === null
      ? []
      : platform === 'android'
        ? [
            {
              label: 'Publisher offers',
              value: formatCount(capture.offeredFrames),
            },
          ]
        : [
            { label: 'Screen frames', value: formatCount(capture.screenFrames) },
            { label: 'Idle frames', value: formatCount(capture.idleFrames) },
            { label: 'Capture deliveries', value: formatCount(capture.offeredFrames) },
            { label: 'Pacer submissions', value: formatCount(capture.forwardedFrames) },
            { label: 'Pump restarts', value: formatCount(capture.pumpRestarts) },
          ];

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
      {pausedMessage && (
        <span role="status" style={{ ...textSize.xs, color: text.warning }}>
          {pausedMessage}
        </span>
      )}
      {measuring && (
        <span role="status" style={{ ...textSize.xs, color: text.tertiary }}>
          Measuring WebRTC stream…
        </span>
      )}
      <div
        role="table"
        aria-label="WebRTC stream statistics"
        aria-colcount={2}
        style={{
          width: '100%',
          overflow: 'visible',
          borderRadius: radius.md,
          backgroundColor: bg.subtle,
        }}
      >
        <div
          role="rowgroup"
          aria-label="Stream statistics"
          data-receiver-stale={stats?.stale || undefined}
          data-server-stale={stats?.serverStale || undefined}
          style={{ display: 'grid', gridTemplateColumns: COMPACT_STATS_COLUMNS }}
        >
          <StreamStatisticGroupHeading label="Stream" />
          <StreamStatisticRow
            label="Server FPS"
            value={formatFps(latest?.serverFps ?? null)}
            stale={stats?.serverStale}
          />
          <StreamStatisticRow
            label="Client FPS"
            value={formatFps(latest?.clientFps ?? null)}
            stale={stats?.stale}
          />
          <StreamStatisticRow
            label="Client bitrate"
            value={formatBitrate(latest?.clientBitrateBps ?? null)}
            stale={stats?.stale}
          />
        </div>
        <div
          role="rowgroup"
          aria-label="Client statistics"
          data-stale={stats?.stale || undefined}
          style={{ display: 'grid', gridTemplateColumns: COMPACT_STATS_COLUMNS }}
        >
          <StreamStatisticGroupHeading label="Client" />
          <StreamStatisticRow
            label="Packet loss"
            value={formatPercentage(latest?.clientPacketLossRatio ?? null)}
            stale={stats?.stale}
          />
          <StreamStatisticRow
            label="Jitter"
            value={formatMilliseconds(latest?.clientJitterMs ?? null, 1)}
            stale={stats?.stale}
          />
          <StreamStatisticRow
            label="Jitter buffer"
            value={formatMilliseconds(latest?.clientJitterBufferMs ?? null, 0)}
            stale={stats?.stale}
          />
          <StreamStatisticRow
            label="Dropped frames"
            value={formatCount(latest?.clientDroppedFrames ?? null)}
            stale={stats?.stale}
          />
          <StreamStatisticRow
            label="Freezes"
            value={formatFreezes(
              latest?.clientFreezeCount ?? null,
              latest?.clientFreezeDurationMs ?? null,
            )}
            stale={stats?.stale}
          />
          <StreamStatisticRow
            label="RTT"
            value={formatMilliseconds(latest?.clientRoundTripMs ?? null, 0)}
            stale={stats?.stale}
          />
          <StreamStatisticRow
            label="ICE path"
            value={formatIcePath(latest?.clientIcePath)}
            stale={stats?.stale}
          />
        </div>
        {encoderRows.length > 0 && (
          <div
            role="rowgroup"
            aria-label="Encoder statistics"
            data-stale={stats?.serverStale || undefined}
            style={{ display: 'grid', gridTemplateColumns: COMPACT_STATS_COLUMNS }}
          >
            <StreamStatisticGroupHeading label="Encoder" />
            {encoderRows.map((row) => (
              <StreamStatisticRow
                key={row.label}
                label={row.label}
                value={row.value}
                stale={stats?.serverStale}
              />
            ))}
          </div>
        )}
        {captureRows.length > 0 && (
          <div
            role="rowgroup"
            aria-label="Capture statistics"
            data-stale={stats?.serverStale || undefined}
            style={{ display: 'grid', gridTemplateColumns: COMPACT_STATS_COLUMNS }}
          >
            <StreamStatisticGroupHeading label="Capture" />
            {captureRows.map((row) => (
              <StreamStatisticRow
                key={row.label}
                label={row.label}
                value={row.value}
                stale={stats?.serverStale}
              />
            ))}
          </div>
        )}
      </div>
      {latest && hasClientMeasurement && (
        <div
          data-stale={stats?.stale || undefined}
          style={{
            display: 'grid',
            minWidth: 0,
            gridTemplateColumns: COMPACT_STATS_COLUMNS,
            gap: 8,
            opacity: stats?.stale ? 0.55 : 1,
          }}
        >
          <MetricChart
            title="Client FPS"
            value={formatFps(latest.clientFps)}
            description="Last 60 samples"
            series={clientFpsSeries}
            maxValue={maxChartValue(clientFpsSeries)}
            bordered={false}
          />
          <MetricChart
            title="Client bitrate"
            value={formatBitrate(latest.clientBitrateBps)}
            description="Last 60 samples"
            series={clientBitrateSeries}
            maxValue={maxChartValue(clientBitrateSeries)}
            bordered={false}
          />
        </div>
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
  const settingsCapabilities = client.capabilities.streamSettings;
  const supportedSettingKeys = settingsCapabilities
    ? STREAM_SETTING_ORDER.filter((key) => settingsCapabilities[key])
    : [];
  const finalSettingKey = supportedSettingKeys.at(-1);
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
