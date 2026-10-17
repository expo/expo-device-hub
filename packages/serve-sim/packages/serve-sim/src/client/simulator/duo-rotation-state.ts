import type { HingePhysicalOrientation } from "../../hinge-control";

const ORIENTATIONS: HingePhysicalOrientation[] = ["portrait", "landscape-left", "pud", "landscape-right"];

/** Track physical rotation independently of delayed or orientation-locked app geometry. */
export function createDuoRotationState() {
  let displayed: number | undefined;
  let pendingUntil = 0;
  return {
    rebase(orientation: HingePhysicalOrientation | undefined) {
      const index = orientation === undefined ? -1 : ORIENTATIONS.indexOf(orientation);
      displayed = index < 0 ? undefined : index;
      pendingUntil = 0;
    },
    request(turns: number, now = Date.now()) {
      pendingUntil = now + 1500;
      if (displayed === undefined) return;
      displayed = ((displayed + turns) % 4 + 4) % 4;
    },
    observe(orientation: HingePhysicalOrientation | undefined, now = Date.now()) {
      const index = orientation === undefined ? -1 : ORIENTATIONS.indexOf(orientation);
      if (index < 0) return 0;
      // With no pre-request physical baseline, a buffered first sample cannot
      // tell us whether the optimistic turn has happened. Wait for the grace
      // timer to seed a settled baseline without turning that camera again.
      if (displayed === undefined) {
        if (now < pendingUntil) return 0;
        displayed = index; pendingUntil = 0; return 0;
      }
      if (pendingUntil > now && index !== displayed) return 0;
      const turns = ((index - displayed + 6) % 4) - 2;
      displayed = index;
      pendingUntil = 0;
      return turns;
    },
  };
}
