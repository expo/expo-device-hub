import type { DeviceOrientation } from "./types";

const READBACK_GRACE_MS = 1500;
const ROTATE_LEFT_CYCLE: Record<DeviceOrientation, DeviceOrientation> = {
  portrait: "landscape_left",
  landscape_left: "portrait_upside_down",
  portrait_upside_down: "landscape_right",
  landscape_right: "portrait",
};

// @ref LLP 0003#rotation-readback — advance requests independently of app readback
export function createRotationCursor(
  initial: DeviceOrientation = "portrait",
  now: () => number = () => performance.now(),
) {
  let orientation =
    typeof initial === "string" && Object.hasOwn(ROTATE_LEFT_CYCLE, initial) ? initial : "portrait";
  let readback = orientation;
  let readbackDeferred = false;
  let pending: DeviceOrientation | null = null;
  let pendingUntil = 0;
  return {
    peekNext(): DeviceOrientation {
      return ROTATE_LEFT_CYCLE[orientation];
    },
    recordSent(requested: DeviceOrientation): void {
      orientation = requested;
      pending = orientation;
      pendingUntil = now() + READBACK_GRACE_MS;
    },
    updateReadback(reported?: DeviceOrientation | null): void {
      if (typeof reported !== "string" || !Object.hasOwn(ROTATE_LEFT_CYCLE, reported)) return;
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
