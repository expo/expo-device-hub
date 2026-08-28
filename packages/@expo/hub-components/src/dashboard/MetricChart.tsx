import { bg, border, radius, text, textSize } from '../primitives';

const CHART_WIDTH = 100;
const CHART_HEIGHT = 28;

export type MetricChartSeries = {
  label: string;
  color: string;
  values: readonly number[];
};

function chartPath(values: readonly number[], maxValue: number) {
  if (values.length === 0) return '';
  const safeMax = Math.max(maxValue, 1);
  const yFor = (rawValue: number) => {
    const value = Number.isFinite(rawValue) ? Math.max(0, rawValue) : 0;
    return CHART_HEIGHT - Math.min(1, value / safeMax) * (CHART_HEIGHT - 2) - 1;
  };

  if (values.length === 1) {
    const y = yFor(values[0]!);
    return `M 0.00 ${y.toFixed(2)} L ${CHART_WIDTH.toFixed(2)} ${y.toFixed(2)}`;
  }

  return values
    .map((rawValue, index) => {
      const x = (index / (values.length - 1)) * CHART_WIDTH;
      const y = yFor(rawValue);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

export function maxChartValue(series: readonly MetricChartSeries[], minimum = 1) {
  return Math.max(minimum, ...series.flatMap((entry) => entry.values));
}

/** A compact, responsive time-series card shared by inspector metrics. */
export function MetricChart({
  title,
  value,
  description,
  series,
  maxValue,
  bordered = true,
}: {
  title: string;
  value: string;
  description?: string;
  series: readonly MetricChartSeries[];
  maxValue: number;
  bordered?: boolean;
}) {
  return (
    <div
      style={{
        minWidth: 0,
        padding: '9px 10px 8px',
        ...(bordered ? { border: `1px solid ${border.secondary}` } : {}),
        borderRadius: radius.md,
        backgroundColor: bg.subtle,
      }}
    >
      <div style={{ display: 'flex', minWidth: 0, alignItems: 'baseline', gap: 8 }}>
        <span style={{ ...textSize.xs, flex: 1, fontWeight: 500, color: text.default }}>
          {title}
        </span>
        <span
          style={{
            ...textSize.xs,
            flexShrink: 0,
            color: text.secondary,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value}
        </span>
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
        style={{ display: 'block', width: '100%', height: 38, marginTop: 7, overflow: 'visible' }}
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
        <div style={{ display: 'flex', minWidth: 0, flexWrap: 'wrap', gap: 12, marginTop: 2 }}>
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
