import { type CSSProperties } from "react";

import { icon, radius, tone as tones, type Tone } from "../theme/tokens";

export type StatusDotProps = {
  /** The status color. `neutral` is a state without a status, such as a device that is off. */
  tone: Tone | "neutral";
  /** Diameter of the dot in px, without the ring. */
  size?: number;
  /** Draw a 2px ring in the tone's border color around the dot. */
  ring?: boolean;
  /**
   * Draw a ring that grows from the dot and fades, for a status that is in
   * progress, such as a live stream. It does not show with reduced motion.
   */
  pulse?: boolean;
  style?: CSSProperties;
};

const RING_WIDTH = 2;

/** The colored dot beside a status label. It is decoration: the label carries the meaning. */
export function StatusDot({ tone, size = 6, ring = false, pulse = false, style }: StatusDotProps) {
  const colors = tone === "neutral" ? null : tones[tone];
  const dot: CSSProperties = {
    display: "block",
    width: size,
    height: size,
    flexShrink: 0,
    boxSizing: "content-box",
    border: ring && colors ? `${RING_WIDTH}px solid ${colors.border}` : undefined,
    borderRadius: radius.full,
    backgroundColor: colors ? colors.icon : icon.quaternary,
  };
  if (!pulse || !colors) return <span aria-hidden style={{ ...dot, ...style }} />;

  // The pulse is a layer under the dot, so the dot and its ring stay sharp above it.
  return (
    <span aria-hidden style={{ position: "relative", display: "block", flexShrink: 0, ...style }}>
      <span
        className="hub-status-pulse"
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: radius.full,
          backgroundColor: colors.icon,
        }}
      />
      <span style={{ ...dot, position: "relative" }} />
    </span>
  );
}
