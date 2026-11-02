import { DEVICE_ORIENTATIONS, nextOrientation } from "./orientation";
import type { DeviceOrientation } from "./types";

export const READBACK_GRACE_MS = 1500;

function isOrientation(value: unknown): value is DeviceOrientation {
  return (DEVICE_ORIENTATIONS as readonly unknown[]).includes(value);
}

// @ref LLP 0003#rotation-readback — advance requests independently of app readback
export function createRotationCursor(
  initial: DeviceOrientation = "portrait",
  now: () => number = () => performance.now(),
) {
  let orientation = isOrientation(initial) ? initial : "portrait";
  let readback = orientation;
  let readbackDeferred = false;
  let pending: DeviceOrientation | null = null;
  let pendingUntil = 0;
  return {
    peekNext(): DeviceOrientation {
      return nextOrientation(orientation);
    },
    recordSent(requested: DeviceOrientation): void {
      orientation = requested;
      pending = orientation;
      pendingUntil = now() + READBACK_GRACE_MS;
    },
    updateReadback(reported?: DeviceOrientation | null): void {
      if (!isOrientation(reported)) return;
      // A duplicate cannot acknowledge a newer request for the same pose.
      if (reported === readback && (!readbackDeferred || now() < pendingUntil)) return;
      readback = reported;
      // Bound protection from older acknowledgements so later external changes
      // can take over even when an app never accepts the requested pose.
      if (pending !== null && reported !== pending && now() < pendingUntil) {
        readbackDeferred = true;
        return;
      }
      readbackDeferred = false;
      orientation = reported;
      pending = null;
    },
  };
}
