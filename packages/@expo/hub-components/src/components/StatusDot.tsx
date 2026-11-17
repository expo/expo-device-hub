import { type CSSProperties } from "react";

import { icon, radius, tone as tones, type Tone } from "../theme/tokens";

export type StatusDotProps = {
  /** The status color. `neutral` is a state without a status, such as a device that is off. */
  tone: Tone | "neutral";
  /** Diameter of the dot in px, without the ring. */
  size?: number;
  /** Draw a 2px ring in the tone's border color around the dot. */
  ring?: boolean;
  style?: CSSProperties;
};

/** The colored dot beside a status label. It is decoration: the label carries the meaning. */
export function StatusDot({ tone, size = 6, ring = false, style }: StatusDotProps) {
  const colors = tone === "neutral" ? null : tones[tone];
  return (
    <span
      aria-hidden
      style={{
        display: "block",
        width: size,
        height: size,
        flexShrink: 0,
        boxSizing: "content-box",
        border: ring && colors ? `2px solid ${colors.border}` : undefined,
        borderRadius: radius.full,
        backgroundColor: colors ? colors.icon : icon.quaternary,
        ...style,
      }}
    />
  );
}
