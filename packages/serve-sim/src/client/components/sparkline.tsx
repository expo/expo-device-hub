import { sparklinePath } from "../utils/format-metrics";

export const SPARK_W = 96;
export const SPARK_H = 24;

/** Minimal filled-area sparkline for a series of values. */
export function Sparkline(
  { values, max, className }: { values: number[]; max?: number; className: string },
) {
  const line = sparklinePath(values, SPARK_W, SPARK_H, max);
  // Close the line down to the baseline and back to fill the area under it.
  const area = line ? `${line} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z` : "";
  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className={`w-full h-8 ${className}`}
    >
      <path d={area} fill="currentColor" opacity={0.12} stroke="none" />
      <SparkPath d={line} />
    </svg>
  );
}

export function SparkPath({ d, className }: { d: string; className?: string }) {
  return (
    <path
      d={d}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      vectorEffect="non-scaling-stroke"
    />
  );
}
