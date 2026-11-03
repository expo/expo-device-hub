import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { type CSSProperties } from "react";

import { border, icon } from "../theme/tokens";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/** The one label of a loading state: the spinner's accessible name and the status pill's text. */
export const LOADING_LABEL = "Loading";

export type ActivityIndicatorProps = {
  /** Width and height in pixels. */
  size?: number;
  /** Text for assistive technology; defaults to {@link LOADING_LABEL}. */
  label?: string;
  style?: CSSProperties;
};

/**
 * Indeterminate spinner, standing in for the website's `ActivityIndicator`
 * (not ported: its source is not available here). It is an SVG animated by
 * SMIL, so it needs no stylesheet in an inline-styled DOM component. With
 * reduced motion, the arc stays still. The status region holds the label as
 * visually hidden text, so screen readers announce it when it appears.
 */
export function ActivityIndicator({
  size = 24,
  label = LOADING_LABEL,
  style,
}: ActivityIndicatorProps) {
  const reducedMotion = usePrefersReducedMotion();
  const strokeWidth = Math.max(2, size / 12);
  const center = size / 2;
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;

  return (
    <span
      role="status"
      style={{ display: "inline-flex", width: size, height: size, flexShrink: 0, ...style }}
    >
      <VisuallyHidden>{label}</VisuallyHidden>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden focusable="false">
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          strokeWidth={strokeWidth}
          style={{ stroke: border.default }}
        />
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${circumference / 4} ${circumference}`}
          transform={`rotate(-90 ${center} ${center})`}
          style={{ stroke: icon.secondary }}
        >
          {reducedMotion ? null : (
            <animateTransform
              attributeName="transform"
              type="rotate"
              from={`-90 ${center} ${center}`}
              to={`270 ${center} ${center}`}
              dur="0.8s"
              repeatCount="indefinite"
            />
          )}
        </circle>
      </svg>
    </span>
  );
}
