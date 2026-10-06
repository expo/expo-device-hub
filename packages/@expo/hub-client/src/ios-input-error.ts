/**
 * The `DeviceClient.input` error for the serve-sim helper's input WebSocket.
 *
 * serve-sim refuses or drops an input socket with close code 1013 when its
 * client limit is reached or a socket's input queue is full
 * (`device-session.ts` `attachHidSocket` / `overloadHidSocket`). Its reason is
 * already a user-facing sentence. It also reports `inputUnavailable` in the
 * screen config after a failed native HID setup, which lasts until serve-sim
 * restarts.
 */

export const IOS_INPUT_BUSY_MESSAGE = 'Simulator input is busy. Retrying…';
export const IOS_INPUT_UNAVAILABLE_MESSAGE =
  'Simulator input is unavailable. Restart serve-sim to retry.';

/** The input error for a closed helper socket, or null when the close does not reject input. */
export function iosInputCloseError(code: number, reason: string): string | null {
  if (code !== 1013) return null;
  return reason || IOS_INPUT_BUSY_MESSAGE;
}
