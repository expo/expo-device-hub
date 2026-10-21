/**
 * The model's own panel IDs. The iPhone Duo scene keys its geometry on
 * Xcode's display IDs (1 for the cover, 3 for the inner display), while
 * `@expo/hub-client` names displays by role. The conversion happens here, at
 * the edge of the model.
 *
 * `DUO_PANEL_FOR_DISPLAY` and `duoDisplayId` intentionally copy hub-client's
 * internal `duo/duo-fold.ts`, which hub-client does not export. Keep the two
 * copies the same.
 */

import { type DeviceDisplayId, type ScreenSize } from "@expo/hub-client";

export type DuoPanelId = 1 | 3;

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
