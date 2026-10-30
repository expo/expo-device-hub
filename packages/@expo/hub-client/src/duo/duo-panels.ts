/**
 * Per-panel stream routes and health for the iPhone Duo's displays, ported from
 * serve-sim's `src/client/components/duo-panel-streams.tsx` (@expo/serve-sim 0.5.0).
 */

import { type WebRtcStreamFailure } from "../webrtc-fallback";
import { type DuoPanelId } from "./duo-fold";

/** Transport of the per-panel streams, the same one the flat stream uses. */
export type DuoPanelStreamMode = "mjpeg" | "avcc" | "webrtc";

/** `…/helper/<udid>` → `…/helper/<udid>/panel/<screenId>`; the middleware serves the panel's capture there. */
export function duoPanelUrl(helperUrl: string, screenId: DuoPanelId): string {
  const url = new URL(helperUrl);
  url.pathname = `${url.pathname.replace(/\/stream\.[^/]+$/, "").replace(/\/+$/, "")}/panel/${screenId}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export type DuoPanelStatus = {
  streaming: boolean;
  error: string | null;
  failure: WebRtcStreamFailure | null;
};

/** Health belongs to the displayed panel; the other decoder can remain healthy independently. */
export function duoPanelStatus(
  mode: DuoPanelStreamMode,
  screenId: number | undefined,
  panels: Record<DuoPanelId, DuoPanelStatus>,
) {
  const panel = panels[screenId === 1 ? 1 : 3];
  const error =
    mode === "webrtc"
      ? (panel.error ??
        (panel.failure
          ? panel.failure.kind === "codec"
            ? "WebRTC could not decode this display."
            : "WebRTC streaming failed for this display."
          : null))
      : null;
  return { streaming: panel.streaming && !error, error };
}
