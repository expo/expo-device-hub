import type { SimulatorOrientation } from "../types";
import { ROTATE_LEFT_CYCLE, ROTATE_RIGHT_CYCLE } from "./orientation";

const READBACK_GRACE_MS = 1500;

/** Briefly ignore delayed readback while advancing through requested poses. */
export function createRotationCursor(
  initial: SimulatorOrientation = "portrait",
  now: () => number = () => performance.now(),
) {
  let orientation = initial;
  let pending: SimulatorOrientation | null = null;
  let pendingUntil = 0;
  return {
    requestNext(direction: "left" | "right" = "left"): SimulatorOrientation {
      orientation = (direction === "left" ? ROTATE_LEFT_CYCLE : ROTATE_RIGHT_CYCLE)[orientation];
      pending = orientation;
      pendingUntil = now() + READBACK_GRACE_MS;
      return orientation;
    },
    updateReadback(reported?: SimulatorOrientation | null): void {
      if (!reported) return;
      // A declined pose may never be acknowledged. Bound the protection from
      // earlier requests so subsequent external rotations can take over.
      if (pending !== null && reported !== pending && now() < pendingUntil) return;
      orientation = reported;
      pending = null;
    },
  };
}
