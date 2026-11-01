/**
 * Width in px of the left sidebar when it covers the dashboard as an overlay.
 *
 * On a phone the overlay fills the visible viewport, so nothing is left to tap beside it.
 * Elsewhere it keeps the width the viewer chose.
 */
export function sidebarOverlayWidth({
  mobile,
  sidebarWidth,
  viewportWidth,
}: {
  mobile: boolean;
  sidebarWidth: number;
  viewportWidth: number;
}): number {
  return mobile ? viewportWidth : sidebarWidth;
}
