import { useState } from 'react';

import { type DeviceActivitySample, type DeviceClient } from '@expo/hub-client';
import { bg, border, radius, text, textSize } from '../primitives';
import { CollapsibleSection } from './CollapsibleSection';

const MAX_SAMPLES = 60;
const CHART_WIDTH = 100;
const CHART_HEIGHT = 28;

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

/** Live CPU, memory, and network history for the foreground iOS app. */
export function ActivitySection({ client }: { client?: DeviceClient }) {
  const [open, setOpen] = useState(false);
  const activity = client?.activity ?? null;
  const samples = activity?.samples.slice(-MAX_SAMPLES) ?? [];
  const latest = latestSample(samples);

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
  const cpuCapacity = Math.max(100, (activity?.hostCores ?? 0) * 100);

  let message: string | null = null;
  if (activity?.errored) message = 'Activity data is unavailable for this app.';
  else if (!latest) message = 'Waiting for activity data…';
  else if (activity?.stale) message = 'Activity data is paused. Showing the most recent samples.';

  return (
    <CollapsibleSection title="Activity" open={open} onOpenChange={setOpen}>
      {message && (
        <span
          role={activity?.errored ? 'alert' : undefined}
          style={{ ...textSize.xs, display: 'block', padding: '2px 0 8px', color: text.tertiary }}
        >
          {message}
        </span>
      )}
      {latest && (
        <div style={{ display: 'flex', minWidth: 0, flexDirection: 'column', gap: 8 }}>
          <MetricChart
            title="CPU"
            value={`${Math.round(latest.cpuPct)}%`}
            description={
              activity?.hostCores
                ? `Up to ${activity.hostCores * 100}% across host cores`
                : undefined
            }
            series={cpuSeries}
            maxValue={Math.max(cpuCapacity, maxOf(cpuSeries))}
          />
          <MetricChart
            title="Memory"
            value={formatBytes(latest.memBytes)}
            series={memorySeries}
            maxValue={maxOf(memorySeries)}
          />
          <MetricChart
            title="Network"
            value={`↓ ${formatBytes(latest.netInBytesPerSec)}/s · ↑ ${formatBytes(latest.netOutBytesPerSec)}/s`}
            series={networkSeries}
            maxValue={maxOf(networkSeries)}
          />
        </div>
      )}
    </CollapsibleSection>
  );
}
