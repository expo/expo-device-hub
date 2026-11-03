/**
 * The model's own panel IDs. The iPhone Duo scene keys its geometry on
 * Xcode's display IDs (1 for the cover, 3 for the inner display), while
 * `@expo/hub-client` names displays by role. The conversion happens here, at
 * the edge of the model. The panel sizes and the fill inset live here too,
 * because this module does not import three.js, so the Hub's frame can use them.
 *
 * `DUO_PANEL_FOR_DISPLAY` and `duoDisplayId` intentionally copy hub-client's
 * internal `duo/duo-fold.ts`, which hub-client does not export.
 * `__tests__/duo-displays.test.ts` checks that the two copies match.
 */

import { type DeviceDisplayId, type ScreenSize } from "@expo/hub-client";

export type DuoPanelId = 1 | 3;

/**
 * Each panel's framebuffer size in DeviceKit. It lays out the hidden source
 * views and sizes the Hub's stage; the scene reads each decoded frame's
 * actual size for its texture mapping.
 */
export const DUO_PANEL_SIZE: Readonly<Record<DuoPanelId, { width: number; height: number }>> = {
  1: { width: 1398, height: 2034 },
  3: { width: 2007, height: 2853 },
};

/** The fill inset at rest, as in serve-sim. */
export const DUO_FILL_INSET = 32;

export const DUO_PANEL_FOR_DISPLAY: Readonly<Record<DeviceDisplayId, DuoPanelId>> = {
  cover: 1,
  inner: 3,
};

/** The display a panel ID names, or undefined while no panel is known. */
export function duoDisplayId(panel: number | undefined): DeviceDisplayId | undefined {
  return panel === 1 ? "cover" : panel === 3 ? "inner" : undefined;
}

/** The client's screen, with the panel ID of the display it describes. */
export type DuoStreamConfig = ScreenSize & { screenId?: number };

export function duoStreamConfig(screen: ScreenSize | null): DuoStreamConfig | null {
  if (!screen) return null;
  return screen.display ? { ...screen, screenId: DUO_PANEL_FOR_DISPLAY[screen.display] } : screen;
}
