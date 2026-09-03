import { type DeviceClient } from '@expo/hub-client';
import { bg, border, radius, text, textSize } from '../primitives';
import {
  MetricChart,
  type MetricChartSeries,
  maxChartValue,
} from './MetricChart';

const MAX_STATS_SAMPLES = 60;
const UNAVAILABLE_VALUE = '—';
const COMPACT_STATS_COLUMNS = 'repeat(auto-fit, minmax(150px, 1fr))';

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

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return UNAVAILABLE_VALUE;
  const safeValue = Math.max(0, value);
  if (safeValue < 1_024) return `${Math.round(safeValue)} B`;
  if (safeValue < 1_048_576) return `${(safeValue / 1_024).toFixed(1)} KiB`;
  return `${(safeValue / 1_048_576).toFixed(2)} MiB`;
}

function formatTimingPair({ p50, p95 }: { p50: number | null; p95: number | null }) {
  if (p50 === null && p95 === null) return UNAVAILABLE_VALUE;
  return `${p50 === null ? UNAVAILABLE_VALUE : p50.toFixed(1)} / ${
    p95 === null ? UNAVAILABLE_VALUE : p95.toFixed(1)
  } ms`;
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

function StreamStatisticGroupHeading({
  label,
  showTopBorder = true,
}: {
  label: string;
  showTopBorder?: boolean;
}) {
  return (
    <div role="row" style={{ gridColumn: '1 / -1' }}>
      <span
        role="columnheader"
        aria-colspan={2}
        style={{
          ...textSize['2xs'],
          display: 'block',
          padding: '7px 8px 5px',
          ...(showTopBorder ? { borderTop: `1px solid ${border.secondary}` } : {}),
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

export function StreamStatistics({
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
  const grpc = capture?.grpc ?? null;
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
              label: 'Configured bitrate',
              value: formatBitrate(encoder.targetBitrateBps),
            },
            {
              label: 'Output frames',
              value: formatCount(encoder.framesEncoded),
            },
            {
              label: 'Publisher FPS',
              value: formatFps(encoder.publisherFps),
            },
            {
              label: 'Payload bitrate',
              value: formatBitrate(encoder.payloadBitrateBps),
            },
            {
              label: 'Publisher submissions',
              value: formatCount(encoder.publisherSubmittedFrames),
            },
            {
              label: 'Publisher drops',
              value: formatCount(encoder.publisherDroppedFrames),
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
            {
              label: 'Publisher forwards',
              value: formatCount(capture.forwardedFrames),
            },
            ...(grpc
              ? [
                  {
                    label: 'gRPC image mode',
                    value: grpc.imageMode?.toUpperCase() ?? UNAVAILABLE_VALUE,
                  },
                  {
                    label: 'Emulator producer FPS',
                    value: formatFps(grpc.producerFps),
                  },
                  {
                    label: 'Host receive FPS',
                    value: formatFps(grpc.receiveFps),
                  },
                  {
                    label: 'Usable image FPS',
                    value: formatFps(grpc.usableImageFps),
                  },
                  {
                    label: 'Encoder input FPS',
                    value: formatFps(grpc.encoderInputFps),
                  },
                  {
                    label: 'gRPC notifications',
                    value: formatCount(grpc.messagesReceived),
                  },
                  {
                    label: 'Selected notifications',
                    value: formatCount(grpc.messagesEmitted),
                  },
                  {
                    label: 'Coalesced notifications',
                    value: formatCount(grpc.messagesCoalesced),
                  },
                  {
                    label: 'Sequence gaps',
                    value: formatCount(grpc.sequenceGaps),
                  },
                  {
                    label: 'Latest image payload',
                    value: formatBytes(grpc.imagePayloadBytes),
                  },
                  {
                    label: 'Logical transport bytes',
                    value: formatBytes(grpc.transportBytes),
                  },
                  {
                    label: 'gRPC message bytes',
                    value: formatBytes(grpc.messageBytesReceived),
                  },
                  {
                    label: 'Produce→receive p50 / p95',
                    value: formatTimingPair(grpc.productionToReceiveLatencyMs),
                  },
                  {
                    label: 'Produce→usable p50 / p95',
                    value: formatTimingPair(grpc.productionToUsableLatencyMs),
                  },
                  {
                    label: 'Protobuf decode p50 / p95',
                    value: formatTimingPair(grpc.protobufDecodeTimeMs),
                  },
                  ...(grpc.imageMode === 'mmap'
                    ? [
                        {
                          label: 'MMAP bytes read',
                          value: formatBytes(grpc.mmapFileBytesRead),
                        },
                        {
                          label: 'MMAP read p50 / p95',
                          value: formatTimingPair(grpc.mmapReadCopyTimeMs),
                        },
                        {
                          label: 'MMAP read retries',
                          value: formatCount(grpc.mmapReadRetries),
                        },
                        {
                          label: 'Torn frames dropped',
                          value: formatCount(grpc.mmapTornFramesDropped),
                        },
                      ]
                    : []),
                ]
              : []),
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
          <StreamStatisticGroupHeading label="Stream" showTopBorder={false} />
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
