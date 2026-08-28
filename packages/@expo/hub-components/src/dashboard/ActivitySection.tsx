import { useState } from 'react';

import { type DeviceActivitySample, type DeviceClient } from '@expo/hub-client';
import { text, textSize } from '../primitives';
import { CollapsibleSection } from './CollapsibleSection';
import {
  MetricChart,
  type MetricChartSeries,
  maxChartValue,
} from './MetricChart';

const MAX_SAMPLES = 60;

function formatBytes(value: number) {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (safeValue < 1024) return `${Math.round(safeValue)} B`;
  if (safeValue < 1024 ** 2) return `${(safeValue / 1024).toFixed(safeValue < 10_240 ? 1 : 0)} KB`;
  if (safeValue < 1024 ** 3) {
    return `${(safeValue / 1024 ** 2).toFixed(safeValue < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  }
  return `${(safeValue / 1024 ** 3).toFixed(1)} GB`;
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

  const cpuSeries: MetricChartSeries[] = [
    { label: 'CPU', color: text.info, values: samples.map((sample) => sample.cpuPct) },
  ];
  const memorySeries: MetricChartSeries[] = [
    { label: 'Memory', color: text.preview, values: samples.map((sample) => sample.memBytes) },
  ];
  const networkSeries: MetricChartSeries[] = [
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
            maxValue={Math.max(cpuCapacity, maxChartValue(cpuSeries))}
          />
          <MetricChart
            title="Memory"
            value={formatBytes(latest.memBytes)}
            series={memorySeries}
            maxValue={maxChartValue(memorySeries)}
          />
          <MetricChart
            title="Network"
            value={`↓ ${formatBytes(latest.netInBytesPerSec)}/s · ↑ ${formatBytes(latest.netOutBytesPerSec)}/s`}
            series={networkSeries}
            maxValue={maxChartValue(networkSeries)}
          />
        </div>
      )}
    </CollapsibleSection>
  );
}
