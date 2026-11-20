/**
 * How a device session ends because the device went away, such as an iPhone that was unplugged or
 * dropped off Wi-Fi. The native screen source reports the end; the session closes its viewers
 * with the reason, and discovery reports the reason until the device is started again, as
 * serve-emu marks a session whose video stream ended terminal.
 */

/** What the native screen source reports when its device goes away. */
export type NativeDeviceEnd = {
  /** `"device-disconnected"` when the device went away; other values are other ends. */
  reason: string;
  /** Native detail, shown for an end other than a disconnect. */
  message?: string;
};

export const DEVICE_DISCONNECTED_REASON = "iPhone disconnected";

/** Close code of an input socket whose device ended. The close reason is the end's reason. */
export const WS_CLOSE_DEVICE_ENDED = 4410;

/** The reason a viewer shows for a native end. */
export function deviceEndReason(end: NativeDeviceEnd): string {
  if (end.reason === "device-disconnected") return DEVICE_DISCONNECTED_REASON;
  return end.message || "The device stream ended";
}

const ended = new Map<string, string>();

export function recordDeviceEnd(udid: string, reason: string): void {
  ended.set(udid.toUpperCase(), reason);
}

export class DeviceEndedError extends Error {}

export function refuseEndedDevice(udid: string): void {
  const reason = ended.get(udid.toUpperCase());
  if (reason) throw new DeviceEndedError(reason);
}

/** A new start of the device clears its end. */
export function clearDeviceEnd(udid: string): void {
  ended.delete(udid.toUpperCase());
}

/**
 * What `/api` and `/api/events` report for an ended device in place of its config. It has no
 * `url`, so a client that does not know `ended` reads it as no device, as before.
 */
export function deviceEndConfig(
  udid: string | null | undefined,
): { device: string; ended: { reason: string } } | null {
  if (!udid) return null;
  const reason = ended.get(udid.toUpperCase());
  return reason ? { device: udid.toUpperCase(), ended: { reason } } : null;
}
