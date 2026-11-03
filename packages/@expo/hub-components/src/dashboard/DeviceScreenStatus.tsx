import { type DeviceClient } from "@expo/hub-client";
import { type CSSProperties } from "react";

import { ActivityIndicator, bg, text, textSize } from "../primitives";

// @ref LLP 0015#states — one spinner until the first frame; no spinner while a loaded screen reconnects
/**
 * Whether the device screen shows its first-load spinner: the screen session
 * is `connecting`, which means that it has not presented a frame, or it shows
 * frames while the consumer's own preview, such as the 3D model, is not ready.
 */
export function deviceScreenLoading(
  client: Pick<DeviceClient, "status">,
  previewReady = true,
): boolean {
  if (client.status === "connecting") return true;
  return !previewReady && (client.status === "streaming" || client.status === "reconnecting");
}

const LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
};

const NOTICE_STYLE: CSSProperties = {
  ...textSize.xs,
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  zIndex: 1,
  // Centered, so a device's rounded screen corners never clip the text.
  padding: "12px 24px",
  textAlign: "center",
  backgroundColor: bg.danger,
  color: text.danger,
  pointerEvents: "none",
};

/**
 * The loading and error layer over a device screen, 2D or 3D. It covers
 * nothing while the stream reconnects, so the last frame stays visible. A
 * stream error replaces an input error, which needs a stream to matter.
 */
export function DeviceScreenStatus({
  loading,
  error,
  inputError,
}: {
  loading: boolean;
  /** The connection's error while `status` is `error`. */
  error: string | null;
  inputError?: string | null;
}) {
  return (
    <>
      {loading && (
        <div data-testid="device-screen-loading" style={LAYER_STYLE}>
          <ActivityIndicator />
        </div>
      )}
      {error ? (
        <div role="alert" style={NOTICE_STYLE}>
          {error}
        </div>
      ) : inputError ? (
        <div role="status" aria-live="polite" style={NOTICE_STYLE}>
          {inputError}
        </div>
      ) : null}
    </>
  );
}
