/**
 * Rotate's request cursor, ported from serve-sim's
 * `src/client/simulator/rotation-cursor.ts` (@expo/serve-sim 0.5.0). Each press
 * advances from the last requested orientation, so presses faster than the
 * helper's config push still turn the device one step each.
 */

import { ROTATE_LEFT_CYCLE, ROTATE_RIGHT_CYCLE } from './orientation';
import { type DeviceOrientation } from './types';

const READBACK_GRACE_MS = 1500;

/** Briefly ignore delayed readback while advancing through requested poses. */
export function createRotationCursor(
  initial: DeviceOrientation = 'portrait',
  now: () => number = () => performance.now(),
) {
  let orientation = initial;
  let pending: DeviceOrientation | null = null;
  let pendingUntil = 0;
  return {
    requestNext(direction: 'left' | 'right' = 'left'): DeviceOrientation {
      orientation = (direction === 'left' ? ROTATE_LEFT_CYCLE : ROTATE_RIGHT_CYCLE)[orientation];
      pending = orientation;
      pendingUntil = now() + READBACK_GRACE_MS;
      return orientation;
    },
    updateReadback(reported?: DeviceOrientation | null): void {
      if (!reported) return;
      // A declined pose may never be acknowledged. Bound the protection from
      // earlier requests so subsequent external rotations can take over.
      if (pending !== null && reported !== pending && now() < pendingUntil) return;
      orientation = reported;
      pending = null;
    },
  };
}
