import { type DeviceChrome } from "./types";

/**
 * The chrome of the display that is streaming. A multi-display device (iPhone Duo) has one
 * chrome per display; serve-sim's preview selects it the same way.
 */
export function deviceChromeForScreen(
  chrome: DeviceChrome,
  screenId: number | undefined,
): DeviceChrome {
  return (screenId === undefined ? undefined : chrome.displayVariants?.[screenId]) ?? chrome;
}
