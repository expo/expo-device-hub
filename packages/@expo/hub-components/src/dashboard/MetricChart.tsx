import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { useId } from 'react';

import { bg, radius, text, textSize } from '../primitives';

const CHART_WIDTH = 100;
const CHART_HEIGHT = 48;
/** Keeps the 2px stroke fully inside the card at the top of the range. */
const CHART_TOP_INSET = 2;
const CHART_BASELINE = CHART_HEIGHT - 1;

export type MetricChartSeries = {
  label: string;
  color: string;
  values: readonly number[];
  /** Draw a dashed line, to tell a secondary series from the primary one. */
  dashed?: boolean;
};

function chartPoints(values: readonly number[], maxValue: number) {
  const safeMax = Math.max(maxValue, 1);
  const yFor = (rawValue: number) => {
    const value = Number.isFinite(rawValue) ? Math.max(0, rawValue) : 0;
    const ratio = Math.min(1, value / safeMax);
    return CHART_BASELINE - ratio * (CHART_BASELINE - CHART_TOP_INSET);
  };

  if (values.length === 1) {
    const y = yFor(values[0]!);
    return [
      { x: 0, y },
      { x: CHART_WIDTH, y },
    ];
  }

  return values.map((rawValue, index) => ({
    x: (index / (values.length - 1)) * CHART_WIDTH,
    y: yFor(rawValue),
  }));
}

function linePath(points: ReadonlyArray<{ x: number; y: number }>) {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
}

function areaPath(points: ReadonlyArray<{ x: number; y: number }>) {
  const first = points[0]!;
  const last = points.at(-1)!;
  return `${linePath(points)} L ${last.x.toFixed(2)} ${CHART_HEIGHT} L ${first.x.toFixed(2)} ${CHART_HEIGHT} Z`;
}

export function maxChartValue(series: readonly MetricChartSeries[], minimum = 1) {
  return Math.max(minimum, ...series.flatMap((entry) => entry.values));
}

/**
 * A time-series card shared by the inspector metrics: an edge-to-edge
 * sparkline with a soft gradient under the primary series, then the metric
 * label and its latest value.
 */
export function MetricChart({
  title,
  value,
  description,
  series,
  maxValue,
}: {
  title: string;
  value: string;
  /**
   * Extra context for the chart: the card's hover tooltip, and the chart's
   * accessible description for assistive technology.
   */
  description?: string;
  series: readonly MetricChartSeries[];
  maxValue: number;
}) {
  const gradientId = useId();
  const descriptionId = description ? `${gradientId}-description` : undefined;
  const drawn = series
    .filter((entry) => entry.values.length > 0)
    .map((entry, index) => ({ ...entry, points: chartPoints(entry.values, maxValue), index }));
  const legend = drawn.length > 1 ? ` (${drawn.map((entry) => entry.label).join(', ')})` : '';

  return (
    <div
      title={description}
      style={{
        minWidth: 0,
        overflow: 'hidden',
        borderRadius: radius.lg,
        backgroundColor: bg.subtle,
      }}
    >
      <svg
        role="img"
        aria-label={`${title}: ${value}${legend}`}
        aria-describedby={descriptionId}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        style={{ display: 'block', width: '100%', height: CHART_HEIGHT, overflow: 'visible' }}
      >
        <defs>
          {drawn.slice(0, 1).map((entry) => (
            <linearGradient
              key={entry.label}
              id={`${gradientId}-${entry.index}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0" stopColor={entry.color} stopOpacity="0.55" />
              <stop offset="1" stopColor={entry.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {drawn.slice(0, 1).map((entry) => (
          <path
            key={`${entry.label}-area`}
            d={areaPath(entry.points)}
            fill={`url(#${gradientId}-${entry.index})`}
            stroke="none"
          />
        ))}
        {drawn.map((entry) => (
          <path
            key={entry.label}
            d={linePath(entry.points)}
            fill="none"
            stroke={entry.color}
            strokeWidth="2"
            strokeDasharray={entry.dashed ? '4 3' : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div
        style={{
          display: 'flex',
          minWidth: 0,
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 10px',
        }}
      >
        <span style={{ ...textSize.xs, minWidth: 0, color: text.secondary }}>{title}</span>
        <span
          style={{
            ...textSize.xs,
            flexShrink: 0,
            color: text.default,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {value}
        </span>
      </div>
      {description && <VisuallyHidden id={descriptionId}>{description}</VisuallyHidden>}
    </div>
  );
}
