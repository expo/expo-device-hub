/**
 * When a device screen counts as loading, and when it keeps its last frame.
 * Both adapters pass their own connection status through this policy, so iOS
 * and Android report the same states to every consumer.
 */

import { useState } from "react";

import { type ConnectionStatus } from "./types";
import { useVisibleTimeout } from "./visible-timeout";

/** How long a screen session may wait for its first frame before it reports an error. */
export const SCREEN_LOAD_TIMEOUT_MS = 30_000;

/** The error of a screen session that has not shown a frame in time. The adapter keeps retrying. */
export const SCREEN_LOAD_TIMEOUT_ERROR = "The device screen did not load. Retrying…";

/** The error of a loaded screen whose stream stayed away too long. The adapter keeps retrying. */
export const STREAM_DISCONNECTED_ERROR = "Disconnected — retrying…";

export interface ScreenPresentation {
  status: ConnectionStatus;
  error: string | null;
  /** Whether the current screen session has presented a frame. */
  framePresented: boolean;
}

export interface ScreenPresentationOptions {
  /**
   * How long a loaded screen may reconnect before it reports an error over
   * its last frame. Without it, only the adapter ends a reconnect.
   */
  dropTimeoutMs?: number;
}

// @ref LLP 0015#states — only a session without a frame shows loading; a frame turns gaps into reconnects
/**
 * Map an adapter's own status onto what the screen presents. Before the first
 * frame of a session, a gap is loading until the load timeout. After it, a gap
 * is a reconnect that keeps the last frame, until the optional drop timeout.
 * Errors pass through unchanged.
 */
export function presentScreen(
  status: ConnectionStatus,
  error: string | null,
  framePresented: boolean,
  loadTimedOut: boolean,
  dropTimedOut = false,
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
      if (framePresented) {
        return dropTimedOut
          ? { status: "error", error: STREAM_DISCONNECTED_ERROR, framePresented }
          : { status: "reconnecting", error: null, framePresented };
      }
      if (loadTimedOut) {
        return { status: "error", error: SCREEN_LOAD_TIMEOUT_ERROR, framePresented };
      }
      return { status: "connecting", error: null, framePresented };
  }
}

type SessionState = {
  key: string | null;
  framePresented: boolean;
  loadTimedOut: boolean;
  dropTimedOut: boolean;
};

const freshSession = (key: string | null): SessionState => ({
  key,
  framePresented: false,
  loadTimedOut: false,
  dropTimedOut: false,
});

// @ref LLP 0015#screen-sessions — a new session starts as connecting in the render that changes its key
/**
 * An adapter's own status and error for one screen session. `sessionKey`
 * names the session (null while inactive). A new key resets both in the
 * render that changes it, so a previous session's `streaming` never counts
 * for the new one.
 */
export function useSessionStatus(sessionKey: string | null) {
  const [status, setStatus] = useState<ConnectionStatus>(sessionKey ? "connecting" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [statusKey, setStatusKey] = useState(sessionKey);
  if (statusKey === sessionKey) return { status, setStatus, error, setError };
  // React renders again before it commits, and this render already sees the reset.
  const reset: ConnectionStatus = sessionKey ? "connecting" : "idle";
  setStatusKey(sessionKey);
  setStatus(reset);
  setError(null);
  return { status: reset, setStatus, error: null, setError };
}

/**
 * Track one screen session: its first frame, its load timeout, and its
 * optional drop timeout. `sessionKey` names the session (null while
 * inactive). Pass the status of {@link useSessionStatus} with the same key.
 */
export function useScreenPresentation(
  sessionKey: string | null,
  status: ConnectionStatus,
  error: string | null,
  { dropTimeoutMs }: ScreenPresentationOptions = {},
): ScreenPresentation {
  const [session, setSession] = useState<SessionState>(() => freshSession(sessionKey));
  let current = session;
  if (current.key !== sessionKey) {
    // React renders again before it commits; only that render sees the reset status.
    current = freshSession(sessionKey);
  } else if (status === "streaming" && (!current.framePresented || current.dropTimedOut)) {
    current = { ...current, framePresented: true, loadTimedOut: false, dropTimedOut: false };
  }
  if (current !== session) setSession(current);

  const gap = sessionKey !== null && (status === "connecting" || status === "reconnecting");
  useVisibleTimeout(
    gap && !current.framePresented,
    SCREEN_LOAD_TIMEOUT_MS,
    () =>
      setSession((previous) =>
        previous.key === sessionKey && !previous.framePresented
          ? { ...previous, loadTimedOut: true }
          : previous,
      ),
    sessionKey,
  );
  // @ref LLP 0015#errors — iOS bounds a reconnect like a first load; Android ends its own
  useVisibleTimeout(
    gap && current.framePresented && dropTimeoutMs !== undefined,
    dropTimeoutMs ?? 0,
    () =>
      setSession((previous) =>
        previous.key === sessionKey && previous.framePresented
          ? { ...previous, dropTimedOut: true }
          : previous,
      ),
    sessionKey,
  );

  return presentScreen(
    status,
    error,
    current.framePresented,
    current.loadTimedOut,
    current.dropTimedOut,
  );
}
