import { useState } from 'react';

import { type DeviceActivitySample, type DeviceClient } from '@expo/hub-client';
import { icon, text, textSize } from '../primitives';
import { CollapsibleSection } from './CollapsibleSection';
import {
  MetricChart,
  type MetricChartSeries,
  maxChartValue,
} from './MetricChart';

const MAX_SAMPLES = 60;
/** The CPU sparkline always shows at least one full core of headroom. */
const MIN_CPU_SCALE_PCT = 100;

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

/**
 * Live CPU, memory, and network history for the foreground iOS app: a status
 * line while data is missing or paused, then one sparkline card per metric.
 * Rendered inside the Current app section; {@link ActivitySection} wraps it
 * in its own collapsible section for standalone use.
 */
export function ActivityCharts({ client }: { client?: DeviceClient }) {
  const activity = client?.activity ?? null;
  const samples = activity?.samples.slice(-MAX_SAMPLES) ?? [];
  const latest = latestSample(samples);

  const cpuSeries: MetricChartSeries[] = [
    { label: 'CPU', color: icon.success, values: samples.map((sample) => sample.cpuPct) },
  ];
  const memorySeries: MetricChartSeries[] = [
    { label: 'Memory', color: icon.info, values: samples.map((sample) => sample.memBytes) },
  ];
  const networkSeries: MetricChartSeries[] = [
    {
      label: 'Inbound',
      color: icon.preview,
      values: samples.map((sample) => sample.netInBytesPerSec),
    },
    {
      label: 'Outbound',
      color: icon.preview,
      dashed: true,
      values: samples.map((sample) => sample.netOutBytesPerSec),
    },
  ];

  let message: string | null = null;
  if (activity?.errored) message = 'Activity data is unavailable for this app.';
  else if (!latest) message = 'Waiting for activity data…';
  else if (activity?.stale) message = 'Activity data is paused. Showing the most recent samples.';

  return (
    <div data-testid="activity-charts" style={{ minWidth: 0, paddingTop: 8 }}>
      {message && (
        <span
          role={activity?.errored ? 'alert' : undefined}
          style={{ ...textSize.xs, display: 'block', padding: '2px 0 8px', color: text.tertiary }}
        >
          {message}
        </span>
      )}
      {latest && (
        <div
          style={{
            display: 'flex',
            minWidth: 0,
            flexDirection: 'column',
            gap: 4,
            paddingTop: message ? 0 : 4,
          }}
        >
          <MetricChart
            title="CPU"
            value={`${Math.round(latest.cpuPct)}%`}
            description={
              activity?.hostCores
                ? `Up to ${activity.hostCores * 100}% across host cores`
                : undefined
            }
            series={cpuSeries}
            maxValue={maxChartValue(cpuSeries, MIN_CPU_SCALE_PCT)}
          />
          <MetricChart
            title="Memory"
            value={formatBytes(latest.memBytes)}
            series={memorySeries}
            maxValue={maxChartValue(memorySeries)}
          />
          <MetricChart
            title="Network"
            value={`↑ ${formatBytes(latest.netOutBytesPerSec)}/s · ↓ ${formatBytes(latest.netInBytesPerSec)}/s`}
            description="Solid line: inbound. Dashed line: outbound."
            series={networkSeries}
            maxValue={maxChartValue(networkSeries)}
          />
        </div>
      )}
    </div>
  );
}

/** {@link ActivityCharts} in a standalone collapsible section. */
export function ActivitySection({ client }: { client?: DeviceClient }) {
  const [open, setOpen] = useState(false);

  return (
    <CollapsibleSection title="Activity" open={open} onOpenChange={setOpen}>
      <ActivityCharts client={client} />
    </CollapsibleSection>
  );
}
