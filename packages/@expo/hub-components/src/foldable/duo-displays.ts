/**
 * The model's own panel IDs. The iPhone Duo scene keys its geometry on
 * Xcode's display IDs (1 for the cover, 3 for the inner display), while
 * `@expo/hub-client` names displays by role. The conversion happens here, at
 * the edge of the model.
 *
 * `DUO_PANEL_FOR_DISPLAY` and `duoDisplayId` intentionally copy hub-client's
 * internal `duo/duo-fold.ts`, which hub-client does not export.
 * `__tests__/duo-displays.test.ts` checks that the two copies match.
 */

import { type DeviceDisplayId, type ScreenSize } from "@expo/hub-client";

import { type DeviceModelDescription } from "./device-models";

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

export function duoStreamConfig(
  screen: ScreenSize | null,
  model?: DeviceModelDescription,
): DuoStreamConfig | null {
  if (!screen) return null;
  if (screen.display) return { ...screen, screenId: DUO_PANEL_FOR_DISPLAY[screen.display] };
  // The iPhone Duo's flat stream names its display; one that does not is not yet known.
  if (!model || model.streams === "displays") return screen;
  return { ...screen, screenId: streamedPanel(model, screen) };
}

/**
 * The panel that a flat stream shows when it does not name its display: the
 * model display with the frame's shape, in any orientation. An emulator shows
 * one display at a time, for example the Pixel 9 Pro Fold's cover while folded.
 */
// @ref LLP 0016#android-emulators — serve-emu names no display, so the frame's shape tells the cover from the inner display
export function streamedPanel(
  model: DeviceModelDescription,
  size: { width: number; height: number },
): DuoPanelId {
  const cover = model.displays.cover;
  if (!cover) return 3;
  const shape = (value: { width: number; height: number }) =>
    Math.min(value.width, value.height) / Math.max(value.width, value.height);
  const frame = shape(size);
  return Math.abs(frame - shape(cover.size)) < Math.abs(frame - shape(model.displays.main.size))
    ? 1
    : 3;
}
