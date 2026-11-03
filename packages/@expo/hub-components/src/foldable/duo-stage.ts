/**
 * The iPhone Duo 3D stage's sizes. This module does not import three.js, so
 * the Hub's frame can size the stage without loading the scene.
 */

import { DUO_PANEL_FOR_DISPLAY, type DuoPanelId } from "./duo-displays";

/**
 * Each panel's framebuffer size in DeviceKit. It lays out the hidden source
 * views and sizes the Hub's stage; the scene reads each decoded frame's
 * actual size for its texture mapping.
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
 * The largest side of the 3D stage: the flat cover's long side when its short
 * side is `maxShortSide`, plus the fill inset on each side, on both axes so
 * that any pose or rotation fits.
 */
export function duoStageMaxSide(maxShortSide: number): number {
  const cover = DUO_PANEL_SIZE[DUO_PANEL_FOR_DISPLAY.cover];
  return (maxShortSide * cover.height) / cover.width + 2 * DUO_FILL_INSET;
}
