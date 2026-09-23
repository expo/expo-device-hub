function flag(params: URLSearchParams, key: string): boolean {
  return params.get(key) === "1";
}

export function presentationModeFromSearch(search: string): {
  initial: boolean;
  embedLocked: boolean;
} {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  const embedLocked = flag(params, "embed");
  return { initial: embedLocked || flag(params, "fullscreen"), embedLocked };
}

export function applyFullscreenSearch(href: string, presentation: boolean): string {
  const url = new URL(href);
  if (flag(url.searchParams, "embed")) return url.toString();
  if (presentation) url.searchParams.set("fullscreen", "1");
  else url.searchParams.delete("fullscreen");
  return url.toString();
}

export function writeFullscreenSearchParam(presentation: boolean): void {
  try {
    window.history.replaceState(null, "", applyFullscreenSearch(window.location.href, presentation));
  } catch {}
}

export type EscapeKeyOutcome = {
  swallow: boolean;
  exit: boolean;
  /** Carries a swallowed keydown to its keyup; the caller clears it on blur. */
  swallowing: boolean;
};

// Escape is also a relayed HID key, so a swallowed keydown must swallow its
// keyup too or the simulator sees a release without a press.
export function escapeKeyOutcome(
  event: { type: "keydown" | "keyup"; repeat: boolean },
  state: { presentation: boolean; swallowing: boolean },
): EscapeKeyOutcome {
  if (!state.presentation && !state.swallowing) {
    return { swallow: false, exit: false, swallowing: state.swallowing };
  }
  if (event.type === "keyup") return { swallow: true, exit: false, swallowing: false };
  return {
    swallow: true,
    exit: !event.repeat && state.presentation,
    swallowing: true,
  };
}

export const PRESENTATION_EXIT_BUTTON_SIZE = 30;
export const PRESENTATION_EXIT_WRAPPER_PADDING = 4;
export const PRESENTATION_EXIT_MARGIN = 12;

const EXIT_EXTENT = PRESENTATION_EXIT_WRAPPER_PADDING + PRESENTATION_EXIT_BUTTON_SIZE;

// The device fills the viewport, so the control sits in whichever gutter its
// aspect ratio leaves: beside it when wide, above it when tall.
export function presentationExitOffset(gutters: {
  side: number;
  top: number;
}): { top: number; right: number } {
  if (gutters.side >= PRESENTATION_EXIT_MARGIN + EXIT_EXTENT) {
    return { top: PRESENTATION_EXIT_MARGIN, right: PRESENTATION_EXIT_MARGIN };
  }
  const top = Math.max(0, Math.min(PRESENTATION_EXIT_MARGIN, gutters.top - EXIT_EXTENT));
  return { top, right: PRESENTATION_EXIT_MARGIN };
}

export const PRESENTATION_CORNERS = [
  "top-right",
  "top-left",
  "bottom-right",
  "bottom-left",
] as const;
export type PresentationCorner = (typeof PRESENTATION_CORNERS)[number];
export const PRESENTATION_CORNER_STORAGE_KEY = "serve-sim:presentation-corner";

export function isPresentationCorner(value: unknown): value is PresentationCorner {
  return PRESENTATION_CORNERS.includes(value as PresentationCorner);
}

/** Corner the controls should snap to after being dragged to (x, y). */
export function nearestCorner(
  x: number,
  y: number,
  viewport: { width: number; height: number },
): PresentationCorner {
  const right = x >= viewport.width / 2;
  const bottom = y >= viewport.height / 2;
  if (bottom) return right ? "bottom-right" : "bottom-left";
  return right ? "top-right" : "top-left";
}

/**
 * Anchor the control cluster to a corner. Snapping beats free positioning: a
 * stored x/y would have to be re-validated on every rotation, resize and
 * keyboard, and can strand the controls off-screen or back over the device.
 */
export function presentationCornerStyle(
  corner: PresentationCorner,
  gutters: { side: number; top: number },
): { top?: number; bottom?: number; left?: number; right?: number } {
  const { top, right } = presentationExitOffset(gutters);
  const vertical = corner.startsWith("top") ? { top } : { bottom: top };
  const horizontal = corner.endsWith("right") ? { right } : { left: right };
  return { ...vertical, ...horizontal };
}
