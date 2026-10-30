import { bg } from "@expo/hub-components";

/**
 * The color to paint the page behind the dashboard on a phone, or null to leave it alone.
 *
 * On a phone the dashboard is a fixed box that fits the visible viewport. The browser's
 * translucent bottom bars (the address pill and keyboard toolbar) show the page behind
 * that box, so the page takes the color of the surface above them: the open sidebar's, or
 * the stream panel's.
 */
export function pageBackground({
  mobile,
  sidebarOverlay,
}: {
  mobile: boolean;
  sidebarOverlay: boolean;
}): string | null {
  if (!mobile) return null;
  return sidebarOverlay ? bg.default : bg.subtle;
}
