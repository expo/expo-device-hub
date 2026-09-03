/**
 * Reconnect policy shared by the device clients.
 *
 * A stream that was already live keeps its last frame on screen for a short
 * grace period while its transport re-establishes itself, so a deliberate
 * server-side restart (for example an Android capture-source switch, which
 * replaces the serve-emu session and closes every viewer socket) never blanks
 * the device frame. Only an outage that outlives the grace period is reported
 * as a disconnect.
 */

/** How long an interrupted live stream keeps presenting its last frame. */
export const STREAM_RECONNECT_GRACE_MS = 5_000;
export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 5_000;
export const RECONNECT_BACKOFF_FACTOR = 1.6;
/**
 * Delay before the first retry after the server closed a healthy socket on
 * purpose. The replacement stream is normally published before the close
 * frame arrives, so waiting out the regular backoff only prolongs the gap.
 */
export const SERVER_RESTART_RECONNECT_DELAY_MS = 100;

/**
 * WebSocket close codes a server uses when it closes a client on purpose:
 * normal closure, "going away" (serve-emu's `server stopping`), and service
 * restart (serve-emu's `stream source switched`). Abnormal closures (1006) and
 * protocol/policy failures keep the regular backoff.
 */
const DELIBERATE_SERVER_CLOSE_CODES: ReadonlySet<number> = new Set([1000, 1001, 1012]);

export function isDeliberateServerClose(code: number): boolean {
  return DELIBERATE_SERVER_CLOSE_CODES.has(code);
}

export interface ReconnectSchedule {
  /** Delay before the next connection attempt. */
  retryIn: number;
  /** Backoff to use if that attempt also fails. */
  nextDelay: number;
}

/**
 * Decide when to retry after a socket closed.
 *
 * `wasHealthy` says whether the closed socket had delivered its payload (video
 * frames, or an open control channel). A deliberate server close of a healthy
 * socket retries almost immediately; every other close waits out the current
 * exponential backoff, which the caller resets once a connection is healthy.
 */
export function scheduleReconnect({
  code,
  wasHealthy,
  currentDelay,
}: {
  code: number;
  wasHealthy: boolean;
  currentDelay: number;
}): ReconnectSchedule {
  const retryIn =
    wasHealthy && isDeliberateServerClose(code) ? SERVER_RESTART_RECONNECT_DELAY_MS : currentDelay;
  return {
    retryIn,
    nextDelay: Math.min(
      Math.round(currentDelay * RECONNECT_BACKOFF_FACTOR),
      RECONNECT_MAX_DELAY_MS,
    ),
  };
}
