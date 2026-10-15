import { HINGE_POSES, type HingeControlCommand, type HingePose } from './hinge-control';
import { type DeviceHingeControls } from './types';

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** serve-emu's fold state from `/api/fold`; `posture` keeps its snake_case names. */
export interface AndroidFold {
  supported: boolean;
  posture: string | null;
  hingeAngle: number | null;
  /** The angles the hinge moves through; null when serve-emu cannot tell. */
  hingeRange: { min: number; max: number } | null;
}

/**
 * serve-emu moves the emulator's hinge sensor. Laptop and Tent also need a
 * physical orientation, and Table Mode has no Android counterpart.
 */
export const ANDROID_HINGE_CONTROLS: DeviceHingeControls = {
  poses: ['closed', 'book', 'open'],
  tableMode: false,
  model: false,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseAndroidFold(payload: unknown): AndroidFold | null {
  const fold = asRecord(asRecord(payload)?.fold);
  if (!fold || typeof fold.supported !== 'boolean') return null;
  const range = asRecord(fold.hingeRange);
  const min = finiteNumber(range?.min);
  const max = finiteNumber(range?.max);
  return {
    supported: fold.supported,
    posture: typeof fold.posture === 'string' ? fold.posture : null,
    hingeAngle: finiteNumber(fold.hingeAngle),
    hingeRange: min !== null && max !== null ? { min, max } : null,
  };
}

/**
 * Whether Fold settings can drive this hinge. Like the iPhone Duo's, its
 * presets and slider assume a hinge from 0° (closed) to 180° (flat), so a
 * fold-out hinge that moves from 180° to 360° gets no controls. An unknown
 * range is taken to be 0–180°.
 */
export function canDriveAndroidHinge(fold: AndroidFold): boolean {
  const range = fold.hingeRange;
  return fold.supported && (range === null || (range.min === 0 && range.max === 180));
}

/** Whether two reads describe the same hinge, so a poll can keep the current state. */
export function sameAndroidFold(a: AndroidFold | null, b: AndroidFold): boolean {
  return (
    a !== null &&
    a.supported === b.supported &&
    a.posture === b.posture &&
    a.hingeAngle === b.hingeAngle &&
    a.hingeRange?.min === b.hingeRange?.min &&
    a.hingeRange?.max === b.hingeRange?.max
  );
}

/** The hinge angle that applies a command on an Android emulator, or why it cannot. */
export function androidHingeAngleFor(
  command: HingeControlCommand,
): { angle: number } | { error: string } {
  switch (command.control) {
    case 'angle':
      return { angle: command.value };
    case 'pose': {
      const pose = HINGE_POSES.find(({ id }) => id === command.value)!;
      return ANDROID_HINGE_CONTROLS.poses.includes(pose.id)
        ? { angle: pose.angle }
        : { error: `The ${pose.label} pose is not available on Android emulators.` };
    }
    case 'table':
      return { error: 'Table Mode is not available on Android emulators.' };
    case 'physical':
      return { error: 'Face up and face down are not available on Android emulators.' };
  }
}

/**
 * Without a physical orientation to tell Book from Laptop, the pose follows
 * from the angle alone: a preset's exact angle, or null for a custom one.
 */
export function androidHingePose(angle: number | undefined): HingePose | null | undefined {
  if (angle === undefined) return undefined;
  return (
    ANDROID_HINGE_CONTROLS.poses.find(
      (id) => HINGE_POSES.find((pose) => pose.id === id)!.angle === angle,
    ) ?? null
  );
}

export interface AndroidHingeBackend {
  /** Null when the read could not be answered, so the next poll retries. */
  read: (signal: AbortSignal) => Promise<AndroidFold | null>;
  /** Resolves the confirmed state; a rejection's message becomes the hinge error. */
  setAngle: (angle: number) => Promise<AndroidFold>;
}

export function androidHingeBackend(fetchImpl: FetchImpl, url: string): AndroidHingeBackend {
  return {
    async read(signal) {
      try {
        const response = await fetchImpl(url, { cache: 'no-store', signal });
        return response.ok ? parseAndroidFold(await response.json()) : null;
      } catch {
        return null;
      }
    },
    async setAngle(angle) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hingeAngle: angle }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const fold = response.ok ? parseAndroidFold(payload) : null;
      if (fold) return fold;
      const error = asRecord(payload)?.error;
      throw new Error(typeof error === 'string' ? error : `Hinge change failed (${response.status})`);
    },
  };
}
