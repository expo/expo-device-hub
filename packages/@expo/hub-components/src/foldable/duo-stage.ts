/**
 * The 3D stage's sizes. This module does not import three.js, so the Hub's
 * frame can size the stage without loading the scene.
 */

import { type DeviceModelDescription, DEVICE_MODELS } from "./device-models";
import { type DuoPanelId } from "./duo-displays";

/**
 * Each iPhone Duo panel's framebuffer size in DeviceKit. It lays out the
 * hidden source views; the scene reads each decoded frame's actual size for
 * its texture mapping.
 */
export const DUO_PANEL_SIZE: Readonly<Record<DuoPanelId, { width: number; height: number }>> = {
  1: { width: 1398, height: 2034 },
  3: { width: 2007, height: 2853 },
};

/** How far each hinge handle's center sits outside the model's outer edge. */
export const DUO_HANDLE_OFFSET = 16;

/**
 * The fill inset at rest, as in serve-sim. It must be at least
 * {@link DUO_HANDLE_OFFSET}: the fill keeps the model this far from the stage
 * edge, and a limit keeps it at least the handle offset away, so a smaller
 * fill inset would leave the limit, not the fill, in charge on every frame.
 * `StreamPanel`'s 32 px gaps keep the handles clear of the title and the
 * controls.
 */
export const DUO_FILL_INSET = 32;

/**
 * The largest side of a model's 3D stage: the long side of its flat display
 * whose short side is `maxShortSide`, the longest of its displays, plus the
 * fill inset on each side, on both axes so that any pose or rotation fits. For
 * the iPhone Duo that is the cover.
 */
export function modelStageMaxSide(model: DeviceModelDescription, maxShortSide: number): number {
  const longSides = [model.displays.main, model.displays.cover].flatMap((display) =>
    display
      ? [
          (maxShortSide * Math.max(display.size.width, display.size.height)) /
            Math.min(display.size.width, display.size.height),
        ]
      : [],
  );
  return Math.max(...longSides) + 2 * DUO_FILL_INSET;
}

/** The iPhone Duo's {@link modelStageMaxSide}. */
export function duoStageMaxSide(maxShortSide: number): number {
  return modelStageMaxSide(DEVICE_MODELS["ios:iphone-duo"], maxShortSide);
}
