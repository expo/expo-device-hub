import { type CSSProperties, forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { screenShapeClipPath } from "./screen-shape";
import { type ScreenShapeSource, useScreenShape } from "./useScreenShape";

/** Props for {@link DeviceShape}. */
export interface DeviceShapeProps
  extends ScreenShapeSource, Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /**
   * The element's width divided by its height, so the corners keep their share
   * of the short side when the element's proportions differ from the screen's,
   * such as a stream with a slightly different size. Defaults to the shape's own.
   */
  aspectRatio?: number;
  /** Moves every edge of the shape in by this many CSS pixels. Defaults to 0. */
  insetPx?: number;
  children?: ReactNode;
}

/**
 * A `div` clipped to a device's screen shape. Put a `DeviceScreen`, a recorded
 * `<video>`, or any layer of the screen inside it, and give it a size, as for
 * `DeviceScreen`. It only clips: it draws nothing and does not turn, so pointer
 * input inside it keeps its mapping. A model without a known shape gets no clip.
 *
 * ```tsx
 * <DeviceShape client={client} style={{ position: "absolute", inset: 0 }}>
 *   <DeviceScreen client={client} />
 * </DeviceShape>
 * ```
 */
export const DeviceShape = forwardRef<HTMLDivElement, DeviceShapeProps>(function DeviceShape(
  { client, platform, model, display, orientation, shape, aspectRatio, insetPx, style, ...props },
  ref,
) {
  const shown = useScreenShape({ client, platform, model, display, orientation, shape });
  const clippedStyle: CSSProperties | undefined = shown
    ? { ...style, clipPath: screenShapeClipPath(shown, { aspectRatio, insetPx }) }
    : style;
  return (
    <div
      ref={ref}
      data-screen-shape={shown ? "device" : undefined}
      {...props}
      style={clippedStyle}
    />
  );
});
