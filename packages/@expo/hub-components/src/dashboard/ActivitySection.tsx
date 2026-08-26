import { useState } from 'react';

import {
  type DeviceActivity,
  type DeviceActivitySample,
  type DeviceClient,
} from '@expo/hub-client';
import { bg, border, radius, text, textSize } from '../primitives';
import { CollapsibleSection } from './CollapsibleSection';

const MAX_SAMPLES = 60;
const CHART_WIDTH = 100;
const CHART_HEIGHT = 28;

const MOCK_ACTIVITY_SAMPLES: DeviceActivitySample[] = [
  { t: 0, bundleId: 'mock', cpuPct: 18, memBytes: 92, netInBytesPerSec: 16, netOutBytesPerSec: 8 },
  { t: 1, bundleId: 'mock', cpuPct: 31, memBytes: 98, netInBytesPerSec: 28, netOutBytesPerSec: 12 },
  {
    t: 2,
    bundleId: 'mock',
    cpuPct: 24,
    memBytes: 105,
    netInBytesPerSec: 21,
    netOutBytesPerSec: 15,
  },
  {
    t: 3,
    bundleId: 'mock',
    cpuPct: 48,
    memBytes: 109,
    netInBytesPerSec: 44,
    netOutBytesPerSec: 19,
  },
  {
    t: 4,
    bundleId: 'mock',
    cpuPct: 39,
    memBytes: 116,
    netInBytesPerSec: 32,
    netOutBytesPerSec: 11,
  },
  {
    t: 5,
    bundleId: 'mock',
    cpuPct: 67,
    memBytes: 121,
    netInBytesPerSec: 51,
    netOutBytesPerSec: 23,
  },
  {
    t: 6,
    bundleId: 'mock',
    cpuPct: 53,
    memBytes: 128,
    netInBytesPerSec: 39,
    netOutBytesPerSec: 17,
  },
];

type ChartSeries = {
  label: string;
  color: string;
  values: number[];
};

function chartPath(values: number[], maxValue: number) {
  if (values.length === 0) return '';
  const safeMax = Math.max(maxValue, 1);

  return values
    .map((rawValue, index) => {
      const x = values.length === 1 ? CHART_WIDTH : (index / (values.length - 1)) * CHART_WIDTH;
      const value = Number.isFinite(rawValue) ? Math.max(0, rawValue) : 0;
      const y = CHART_HEIGHT - Math.min(1, value / safeMax) * (CHART_HEIGHT - 2) - 1;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function formatBytes(value: number) {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (safeValue < 1024) return `${Math.round(safeValue)} B`;
  if (safeValue < 1024 ** 2) return `${(safeValue / 1024).toFixed(safeValue < 10_240 ? 1 : 0)} KB`;
  if (safeValue < 1024 ** 3) {
    return `${(safeValue / 1024 ** 2).toFixed(safeValue < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  }
  return `${(safeValue / 1024 ** 3).toFixed(1)} GB`;
}

function maxOf(series: ChartSeries[], minimum = 1) {
  return Math.max(minimum, ...series.flatMap((entry) => entry.values));
}

function MetricChart({
  title,
  value,
  description,
  series,
  maxValue,
}: {
  title: string;
  value: string;
  description?: string;
  series: ChartSeries[];
  maxValue: number;
}) {
  return (
    <div
      style={{
        padding: '9px 10px 8px',
        border: `1px solid ${border.secondary}`,
        borderRadius: radius.md,
        backgroundColor: bg.subtle,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ ...textSize.xs, flex: 1, fontWeight: 500, color: text.default }}>
          {title}
        </span>
        <span style={{ ...textSize.xs, color: text.secondary }}>{value}</span>
      </div>
      {description && (
        <span style={{ ...textSize['2xs'], display: 'block', color: text.tertiary }}>
          {description}
        </span>
      )}
      <svg
        role="img"
        aria-label={`${title}: ${value}`}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        style={{ display: 'block', width: '100%', height: 38, marginTop: 7 }}
      >
        <line
          x1="0"
          y1={CHART_HEIGHT / 2}
          x2={CHART_WIDTH}
          y2={CHART_HEIGHT / 2}
          stroke={border.secondary}
          strokeWidth="0.5"
          vectorEffect="non-scaling-stroke"
        />
        {series.map((entry) => (
          <path
            key={entry.label}
            d={chartPath(entry.values, maxValue)}
            fill="none"
            stroke={entry.color}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {series.length > 1 && (
        <div style={{ display: 'flex', gap: 12, marginTop: 2 }}>
          {series.map((entry) => (
            <span
              key={entry.label}
              style={{ ...textSize['2xs'], color: entry.color, whiteSpace: 'nowrap' }}
            >
              {entry.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function latestSample(samples: DeviceActivitySample[]) {
  return samples.at(-1) ?? null;
}

function activityPlaceholderMessage(
  activity: DeviceActivity | null,
  latest: DeviceActivitySample | null,
) {
  if (activity?.errored) return 'The activity stream disconnected.';
  if (activity?.stale) return 'Activity data is paused. Waiting for live data.';
  if (latest?.bundleId === null) {
    return 'Only your app is measured. Open your app to see activity.';
  }
  return 'Waiting for activity data.';
}

function ActivityCharts({
  samples,
  hostCores,
  mocked = false,
}: {
  samples: DeviceActivitySample[];
  hostCores: number | null;
  mocked?: boolean;
}) {
  const latest = latestSample(samples)!;
  const cpuSeries: ChartSeries[] = [
    { label: 'CPU', color: text.info, values: samples.map((sample) => sample.cpuPct) },
  ];
  const memorySeries: ChartSeries[] = [
    { label: 'Memory', color: text.preview, values: samples.map((sample) => sample.memBytes) },
  ];
  const networkSeries: ChartSeries[] = [
    {
      label: 'Inbound',
      color: text.success,
      values: samples.map((sample) => sample.netInBytesPerSec),
    },
    {
      label: 'Outbound',
      color: text.warning,
      values: samples.map((sample) => sample.netOutBytesPerSec),
    },
  ];
  return (
    <div style={{ display: 'flex', minWidth: 0, flexDirection: 'column', gap: 8 }}>
      <MetricChart
        title="CPU"
        value={mocked ? '—' : `${Math.round(latest.cpuPct)}%`}
        description={
          mocked
            ? '\u00a0'
            : hostCores
              ? `${hostCores} ${hostCores === 1 ? 'core' : 'cores'}`
              : undefined
        }
        series={cpuSeries}
        maxValue={maxOf(cpuSeries)}
      />
      <MetricChart
        title="Memory"
        value={mocked ? '—' : formatBytes(latest.memBytes)}
        series={memorySeries}
        maxValue={maxOf(memorySeries)}
      />
      <MetricChart
        title="Network"
        value={
          mocked
            ? '—'
            : `↓ ${formatBytes(latest.netInBytesPerSec)}/s · ↑ ${formatBytes(latest.netOutBytesPerSec)}/s`
        }
        series={networkSeries}
        maxValue={maxOf(networkSeries)}
      />
    </div>
  );
}

/** Activity graphs, or a graph-sized explanation while no foreground-app sample is live. */
export function ActivitySectionContent({ activity }: { activity: DeviceActivity | null }) {
  const samples = activity?.samples.slice(-MAX_SAMPLES) ?? [];
  const latest = latestSample(samples);
  const live =
    latest !== null && latest.bundleId !== null && !activity?.errored && !activity?.stale;

  if (live) {
    return <ActivityCharts samples={samples} hostCores={activity?.hostCores ?? null} />;
  }

  const message = activityPlaceholderMessage(activity, latest);
  return (
    <div data-activity-placeholder="true" style={{ position: 'relative', minWidth: 0 }}>
      <div data-activity-mock="true" aria-hidden="true" style={{ opacity: 0.28 }}>
        <ActivityCharts samples={MOCK_ACTIVITY_SAMPLES} hostCores={null} mocked />
      </div>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
        }}
      >
        <span
          role={activity?.errored ? 'alert' : 'status'}
          style={{
            ...textSize.xs,
            maxWidth: 240,
            padding: '8px 10px',
            border: `1px solid ${border.secondary}`,
            borderRadius: radius.md,
            backgroundColor: bg.default,
            color: text.secondary,
            textAlign: 'center',
          }}
        >
          {message}
        </span>
      </div>
    </div>
  );
}

/** Live CPU, memory, and network history for the foreground iOS app. */
export function ActivitySection({ client }: { client?: DeviceClient }) {
  const [open, setOpen] = useState(false);
  const activity = client?.activity ?? null;

  return (
    <CollapsibleSection title="Activity" open={open} onOpenChange={setOpen}>
      <ActivitySectionContent activity={activity} />
    </CollapsibleSection>
  );
}
