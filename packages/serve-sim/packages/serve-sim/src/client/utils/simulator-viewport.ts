// @ref LLP 0003#preview-layout — session target and layout contract
import { SIMULATOR_RESIZE_ABSOLUTE_MIN_WIDTH } from "./simulator-resize";

/** Space available to center and resize the device between docked panels. */
export function getSimulatorViewport(
  viewportWidth: number,
  leftPanelWidth: number,
  rightPanelWidth: number,
) {
  const PAGE_GUTTER = 24;
  const PANEL_EDGE_OFFSET = 12;
  const DESKTOP_BREAKPOINT = 640;
  const minContentWidth = SIMULATOR_RESIZE_ABSOLUTE_MIN_WIDTH + 2 * PAGE_GUTTER;
  // Small screens use overlay panels. On desktop, reserve the right panel
  // first, then dock the device list only if a usable device area remains.
  const right =
    viewportWidth >= DESKTOP_BREAKPOINT &&
    rightPanelWidth > 0 &&
    viewportWidth - rightPanelWidth - PANEL_EDGE_OFFSET >= minContentWidth
      ? rightPanelWidth + PANEL_EDGE_OFFSET
      : 0;
  const left =
    viewportWidth >= DESKTOP_BREAKPOINT &&
    leftPanelWidth > 0 &&
    viewportWidth - right - leftPanelWidth >= minContentWidth
      ? leftPanelWidth
      : 0;
  return { left, right, width: viewportWidth - left - right };
}
