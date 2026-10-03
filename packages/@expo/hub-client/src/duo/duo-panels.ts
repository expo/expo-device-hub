/**
 * Per-panel stream routes and health for the iPhone Duo model, ported from
 * serve-sim's `src/client/components/duo-panel-streams.tsx` (@expo/serve-sim 0.5.0).
 */

import { type DuoPanelStreamMode, type ScreenSize } from '../types';
import { type WebRtcStreamFailure } from '../webrtc-fallback';

export type DuoPanelId = 1 | 3;

/** `…/helper/<udid>` → `…/helper/<udid>/panel/<screenId>`; the middleware serves the panel's capture there. */
export function duoPanelUrl(helperUrl: string, screenId: DuoPanelId): string {
  const url = new URL(helperUrl);
  url.pathname = `${url.pathname.replace(/\/stream\.[^/]+$/, '').replace(/\/+$/, '')}/panel/${screenId}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export type DuoPanelStatus = {
  streaming: boolean;
  error: string | null;
  failure: WebRtcStreamFailure | null;
};

export const EMPTY_DUO_PANEL_STATUS: DuoPanelStatus = { streaming: false, error: null, failure: null };

/** Health belongs to the displayed panel; the other decoder can remain healthy independently. */
export function duoPanelStatus(
  mode: DuoPanelStreamMode,
  screenId: number | undefined,
  panels: Record<DuoPanelId, DuoPanelStatus>,
) {
  const panel = panels[screenId === 1 ? 1 : 3];
  const error =
    mode === 'webrtc'
      ? (panel.error ??
        (panel.failure
          ? panel.failure.kind === 'codec'
            ? 'WebRTC could not decode this display.'
            : 'WebRTC streaming failed for this display.'
          : null))
      : null;
  return { streaming: panel.streaming && !error, error };
}

// Framebuffer dimensions only establish the hidden source view's layout.
// The scene reads each decoded frame's actual size for its texture mapping.
export const DUO_PANEL_CONFIG: Record<DuoPanelId, ScreenSize> = {
  1: { width: 1398, height: 2034, screenId: 1, orientation: 'portrait' },
  3: { width: 2007, height: 2853, screenId: 3, orientation: 'portrait' },
};
