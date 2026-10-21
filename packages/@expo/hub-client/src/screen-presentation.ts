/**
 * When a device screen counts as loading, and when it keeps its last frame.
 * Both adapters pass their own connection status through this policy, so iOS
 * and Android report the same states to every consumer.
 */

import { useEffect, useState } from "react";

import { type ConnectionStatus } from "./types";

/** How long a screen session may wait for its first frame before it reports an error. */
export const SCREEN_LOAD_TIMEOUT_MS = 30_000;

/** The error of a screen session that has not shown a frame in time. The adapter keeps retrying. */
export const SCREEN_LOAD_TIMEOUT_ERROR = "The device screen did not load. Retrying…";

export interface ScreenPresentation {
  status: ConnectionStatus;
  error: string | null;
  /** Whether the current screen session has presented a frame. */
  framePresented: boolean;
}

// @ref LLP 0015#states — only a session without a frame shows loading; a frame turns gaps into reconnects
/**
 * Map an adapter's own status onto what the screen presents. Before the first
 * frame of a session, a gap is loading until the load timeout. After it, a gap
 * is a reconnect that keeps the last frame. Errors pass through unchanged.
 */
export function presentScreen(
  status: ConnectionStatus,
  error: string | null,
  framePresented: boolean,
  loadTimedOut: boolean,
): ScreenPresentation {
  switch (status) {
    case "idle":
      return { status, error, framePresented: false };
    case "streaming":
      return { status, error, framePresented: true };
    case "error":
      return { status, error, framePresented };
    case "connecting":
    case "reconnecting":
      if (framePresented) return { status: "reconnecting", error: null, framePresented };
      if (loadTimedOut) {
        return { status: "error", error: SCREEN_LOAD_TIMEOUT_ERROR, framePresented };
      }
      return { status: "connecting", error: null, framePresented };
  }
}

type SessionState = { key: string | null; framePresented: boolean; loadTimedOut: boolean };

/**
 * Track one screen session: its first frame and its load timeout. `sessionKey`
 * names the session (null while inactive). The adapter must reset its own
 * status in the same render that changes the key, so a previous session's
 * `streaming` never counts for the new one.
 */
export function useScreenPresentation(
  sessionKey: string | null,
  status: ConnectionStatus,
  error: string | null,
): ScreenPresentation {
  const [session, setSession] = useState<SessionState>({
    key: sessionKey,
    framePresented: false,
    loadTimedOut: false,
  });
  let current = session;
  if (current.key !== sessionKey) {
    // React renders again before it commits; only that render sees the reset status.
    current = { key: sessionKey, framePresented: false, loadTimedOut: false };
  } else if (status === "streaming" && !current.framePresented) {
    current = { ...current, framePresented: true, loadTimedOut: false };
  }
  if (current !== session) setSession(current);

  const waiting =
    sessionKey !== null &&
    !current.framePresented &&
    (status === "connecting" || status === "reconnecting");
  useEffect(() => {
    if (!waiting) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Like the WebRTC first-frame timeout, a hidden tab does not judge the stream.
    const arm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (typeof document !== "undefined" && document.hidden) return;
      timer = setTimeout(() => {
        setSession((previous) =>
          previous.key === sessionKey && !previous.framePresented
            ? { ...previous, loadTimedOut: true }
            : previous,
        );
      }, SCREEN_LOAD_TIMEOUT_MS);
    };
    arm();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", arm);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", arm);
    };
  }, [waiting, sessionKey]);

  return presentScreen(status, error, current.framePresented, current.loadTimedOut);
}
