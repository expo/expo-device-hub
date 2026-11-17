import { useCallback, useLayoutEffect, useRef } from "react";
import { toast as sonnerToast } from "sonner";

import { WarningIcon, bg, icon, radius, text, textSize } from "../primitives";
import { CLIPBOARD_TOASTER_ID } from "./ClipboardToast";
import { TOAST_PILL_STYLE } from "./ScreenshotToast";

// Short enough for one line of the notice.
export const MODEL_UNAVAILABLE_TEXT = "Could not load 3D. Showing 2D.";

const TOAST_ID = "hub-model-preview-unavailable";
// Long enough to read, short enough to leave the screen clear.
const DISMISS_MS = 5000;
let lastToast = 0;

/**
 * A notice for a 3D model that failed, over the bottom of the device, that leaves by itself.
 * The preview is in 2D by then, so the notice is the only sign of the failure. It also leaves
 * when another device shows.
 */
// @ref LLP 0015#errors — a failed 3D model is a notice that leaves, not a state of the preview
export function useModelUnavailableToast(deviceId: string): () => void {
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = useRef<string | null>(null);
  // A layout effect ends with the commit, so a notice that still waits cannot show for the next device.
  useLayoutEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = null;
      if (shown.current !== null) sonnerToast.dismiss(shown.current);
      shown.current = null;
    },
    [deviceId],
  );
  return useCallback(() => {
    if (pending.current !== null) clearTimeout(pending.current);
    // A model can fail as it mounts, for example without WebGL, and then it reports from an
    // effect of the commit that also mounts the toaster, before the toaster listens. Show the
    // notice after that commit.
    pending.current = setTimeout(() => {
      pending.current = null;
      if (shown.current !== null) sonnerToast.dismiss(shown.current);
      // A new id each time: sonner applies a dismissal on a later frame, to any toast with its id,
      // so a notice with the id of one just dismissed would leave at once.
      shown.current = `${TOAST_ID}-${++lastToast}`;
      sonnerToast.custom(() => <ModelPreviewToast />, {
        id: shown.current,
        toasterId: CLIPBOARD_TOASTER_ID,
        duration: DISMISS_MS,
      });
    }, 0);
  }, []);
}

export function ModelPreviewToast() {
  return (
    <div data-testid="model-preview-toast" role="status" style={TOAST_PILL_STYLE}>
      <span
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.md,
          backgroundColor: bg.element,
          color: icon.warning,
        }}
      >
        <WarningIcon size={18} />
      </span>
      <span
        style={{
          ...textSize.sm,
          minWidth: 0,
          lineHeight: 1.3,
          fontWeight: 600,
          overflowWrap: "anywhere",
          color: text.default,
        }}
      >
        {MODEL_UNAVAILABLE_TEXT}
      </span>
    </div>
  );
}
