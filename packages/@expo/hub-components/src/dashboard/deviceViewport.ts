import { type CSSProperties } from "react";

/** Keep a device's aspect ratio while fitting the exact panel viewport. */
export function deviceViewportStyle({
  maxShortSide,
  ratio,
}: {
  maxShortSide: number;
  ratio: number;
}): CSSProperties {
  const maxWidth = maxShortSide * Math.max(ratio, 1);

  return {
    width: `min(${maxWidth}px, 100cqw, ${(ratio * 100).toFixed(6)}cqh)`,
    aspectRatio: `${ratio}`,
    flexShrink: 0,
    position: "relative",
    isolation: "isolate",
  };
}
