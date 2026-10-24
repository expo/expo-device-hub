import type { HingePhysicalOrientation } from "../../hinge-control";

export const DUO_ROTATION_READBACK_GRACE_MS = 1500;

const ORIENTATIONS: HingePhysicalOrientation[] = [
  "portrait",
  "landscape-left",
  "pud",
  "landscape-right",
];

export function physicalOrientationQuarterTurns(
  orientation: HingePhysicalOrientation | undefined,
): number {
  return orientation === undefined ? -1 : ORIENTATIONS.indexOf(orientation);
}

/** Track physical rotation independently of delayed or orientation-locked app geometry. */
export function createDuoRotationState() {
  let displayed: number | undefined;
  let pendingUntil = 0;
  let baseline: HingePhysicalOrientation | undefined;
  return {
    get pending() {
      return pendingUntil > 0;
    },
    takeBaseline() {
      const value = baseline;
      baseline = undefined;
      return value;
    },
    rebase(orientation: HingePhysicalOrientation | undefined) {
      const index = physicalOrientationQuarterTurns(orientation);
      displayed = index < 0 ? undefined : index;
      pendingUntil = 0;
      baseline = undefined;
    },
    request(turns: number, now = Date.now()) {
      pendingUntil = now + DUO_ROTATION_READBACK_GRACE_MS;
      if (displayed === undefined) return;
      displayed = (((displayed + turns) % 4) + 4) % 4;
    },
    observe(orientation: HingePhysicalOrientation | undefined, now = Date.now()) {
      const index = physicalOrientationQuarterTurns(orientation);
      if (index < 0) return 0;
      // No physical baseline means the optimistic camera was only a guess.
      // Reframe from the first actual sample, then follow subsequent turns;
      // discarding the whole grace interval would lose independent turns.
      if (displayed === undefined) {
        if (pendingUntil > 0) baseline = orientation;
        displayed = index;
        pendingUntil = 0;
        return 0;
      }
      if (pendingUntil > now && index !== displayed) return 0;
      const turns = ((index - displayed + 6) % 4) - 2;
      displayed = index;
      pendingUntil = 0;
      return turns;
    },
  };
}
