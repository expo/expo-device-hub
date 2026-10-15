import { afterEach, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  type AndroidFold,
  type AndroidHingeBackend,
  androidHingeAngleFor,
  androidHingeBackend,
  androidHingePose,
  canDriveAndroidHinge,
  parseAndroidFold,
  sameAndroidFold,
} from '../android-hinge';
import { type DeviceHinge } from '../types';
import { useAndroidHinge } from '../useAndroidHinge';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

const PIXEL_FOLD_RANGE = { min: 0, max: 180 };

function fold(hingeAngle: number, posture = 'half_opened'): AndroidFold {
  return { supported: true, posture, hingeAngle, hingeRange: PIXEL_FOLD_RANGE };
}

describe('Android hinge mapping', () => {
  test('reads serve-emu fold payloads', () => {
    expect(
      parseAndroidFold({
        ok: true,
        fold: { supported: true, posture: 'closed', hingeAngle: 0, hingeRange: PIXEL_FOLD_RANGE },
      }),
    ).toEqual({ supported: true, posture: 'closed', hingeAngle: 0, hingeRange: PIXEL_FOLD_RANGE });
    expect(
      parseAndroidFold({
        ok: true,
        fold: { supported: false, posture: null, hingeAngle: null, hingeRange: null },
      }),
    ).toEqual({ supported: false, posture: null, hingeAngle: null, hingeRange: null });
    // Without a well-formed range, the range is unknown.
    expect(
      parseAndroidFold({ ok: true, fold: { supported: true, posture: 'opened', hingeAngle: 180 } })
        ?.hingeRange,
    ).toBeNull();
    expect(
      parseAndroidFold({
        ok: true,
        fold: { supported: true, posture: 'opened', hingeAngle: 180, hingeRange: { min: '0', max: 180 } },
      })?.hingeRange,
    ).toBeNull();
    expect(parseAndroidFold({ ok: true })).toBeNull();
    expect(parseAndroidFold({ ok: true, fold: { posture: 'closed' } })).toBeNull();
  });

  test('drives a hinge that moves from 0° to 180°, or whose range is unknown', () => {
    expect(canDriveAndroidHinge(fold(90))).toBe(true);
    expect(canDriveAndroidHinge({ ...fold(90), hingeRange: null })).toBe(true);
    // The SDK's 8" Fold-out folds outward, from 180° to 360°.
    expect(canDriveAndroidHinge({ ...fold(180, 'opened'), hingeRange: { min: 180, max: 360 } })).toBe(
      false,
    );
    expect(
      canDriveAndroidHinge({ supported: false, posture: null, hingeAngle: null, hingeRange: null }),
    ).toBe(false);
  });

  test('compares reads by the hinge they describe', () => {
    expect(sameAndroidFold(fold(90), fold(90))).toBe(true);
    expect(sameAndroidFold(null, fold(90))).toBe(false);
    expect(sameAndroidFold(fold(90), fold(91))).toBe(false);
    expect(sameAndroidFold(fold(90), { ...fold(90), hingeRange: null })).toBe(false);
  });

  test('applies angles and the three presets an emulator hinge can reach', () => {
    expect(androidHingeAngleFor({ control: 'angle', value: 42.5 })).toEqual({ angle: 42.5 });
    expect(androidHingeAngleFor({ control: 'pose', value: 'closed' })).toEqual({ angle: 0 });
    expect(androidHingeAngleFor({ control: 'pose', value: 'book' })).toEqual({ angle: 90 });
    expect(androidHingeAngleFor({ control: 'pose', value: 'open' })).toEqual({ angle: 180 });
    expect(androidHingeAngleFor({ control: 'pose', value: 'laptop' })).toEqual({
      error: 'The Laptop pose is not available on Android emulators.',
    });
    expect(androidHingeAngleFor({ control: 'pose', value: 'tent' })).toEqual({
      error: 'The Tent pose is not available on Android emulators.',
    });
    expect(androidHingeAngleFor({ control: 'table', value: true })).toEqual({
      error: 'Table Mode is not available on Android emulators.',
    });
    expect(androidHingeAngleFor({ control: 'physical', value: 'facedown' })).toEqual({
      error: 'Face up and face down are not available on Android emulators.',
    });
  });

  test("names a preset only at its exact angle", () => {
    expect(androidHingePose(undefined)).toBeUndefined();
    expect(androidHingePose(0)).toBe('closed');
    expect(androidHingePose(90)).toBe('book');
    expect(androidHingePose(180)).toBe('open');
    expect(androidHingePose(90.5)).toBeNull();
  });

  test('posts the hinge angle and surfaces serve-emu refusals', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    let reply: Response = Response.json({ ok: true, fold: fold(90) });
    const backend = androidHingeBackend(async (url, init) => {
      requests.push({ url, init });
      return reply;
    }, 'http://hub.test/api/fold?device=emulator-5554');

    expect(await backend.setAngle(90)).toEqual(fold(90));
    expect(requests[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ hingeAngle: 90 });

    reply = Response.json({ ok: false, error: 'Selected emulator does not support folding' }, { status: 400 });
    await expect(backend.setAngle(90)).rejects.toThrow('Selected emulator does not support folding');
    reply = new Response('bad gateway', { status: 502 });
    await expect(backend.setAngle(90)).rejects.toThrow('Hinge change failed (502)');
  });
});

/** A backend whose reads and writes settle only when the test says so. */
function controlledBackend() {
  const reads: Array<(fold: AndroidFold | null) => void> = [];
  const writes: Array<{
    angle: number;
    resolve: (fold: AndroidFold) => void;
    reject: (error: Error) => void;
  }> = [];
  const backend: AndroidHingeBackend = {
    read: () => new Promise((resolve) => reads.push(resolve)),
    setAngle: (angle) =>
      new Promise((resolve, reject) => {
        writes.push({ angle, resolve, reject });
      }),
  };
  return { backend, reads, writes };
}

/** Runs `run`, holding the queue's five-second acknowledgement timeouts for the test to fire. */
function holdTimeouts(timeouts: Array<() => void>, run: () => void) {
  const timers = createGlobalStubs();
  const realSetTimeout = globalThis.setTimeout;
  timers.stubGlobal('setTimeout', (callback: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== 5000) return realSetTimeout(callback, ms, ...rest);
    timeouts.push(callback);
    return 0;
  });
  try {
    run();
  } finally {
    timers.restoreGlobals();
  }
}

async function mount(backend: AndroidHingeBackend | null) {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const intervals: Array<{ callback: () => void; cleared: boolean }> = [];
  stubGlobal('setInterval', (callback: () => void) => intervals.push({ callback, cleared: false }));
  stubGlobal('clearInterval', (id?: number) => {
    if (id) intervals[id - 1]!.cleared = true;
  });
  let hinge: DeviceHinge | null = null;
  function Harness({ target }: { target: AndroidHingeBackend | null }) {
    hinge = useAndroidHinge(target);
    return null;
  }
  await act(async () => {
    renderer = create(<Harness target={backend} />);
  });
  return {
    hinge: () => hinge,
    /** Fires the poll timers that still run. */
    tick: () =>
      act(async () => {
        for (const interval of intervals) if (!interval.cleared) interval.callback();
      }),
    rerender: (target: AndroidHingeBackend | null) =>
      act(async () => renderer!.update(<Harness target={target} />)),
  };
}

/** Times out a change to 30°, then confirms 90°, so the 30° reply can still arrive late. */
async function mountAfterTimedOutChange() {
  const { backend, reads, writes } = controlledBackend();
  const mounted = await mount(backend);
  await act(async () => reads[0]!(fold(180, 'opened')));

  const timeouts: Array<() => void> = [];
  await act(async () =>
    holdTimeouts(timeouts, () => mounted.hinge()!.setControl({ control: 'angle', value: 30 })),
  );
  await act(async () => timeouts[0]!());
  expect(mounted.hinge()).toMatchObject({
    angle: 180,
    pending: false,
    error: 'Device control timed out.',
  });

  await act(async () => mounted.hinge()!.setControl({ control: 'angle', value: 90 }));
  await act(async () => writes[1]!.resolve(fold(90)));
  expect(mounted.hinge()).toMatchObject({ angle: 90, pending: false, error: null });
  return { ...mounted, reads, writes };
}

describe('useAndroidHinge', () => {
  test('stays null until serve-emu reports a hinge, then offers only what Android can do', async () => {
    const { backend, reads } = controlledBackend();
    const { hinge } = await mount(backend);
    expect(hinge()).toBeNull();

    await act(async () => reads[0]!(fold(180, 'opened')));
    expect(hinge()).toMatchObject({
      supported: true,
      angle: 180,
      pose: 'open',
      tableMode: false,
      tableModeAvailable: false,
      modelActive: false,
      modelUrl: null,
      pending: false,
      error: null,
      controls: { poses: ['closed', 'book', 'open'], tableMode: false, model: false },
    });
  });

  test('shows no hinge until serve-emu reports one that Fold settings can drive', async () => {
    const { backend, reads } = controlledBackend();
    const { hinge, tick } = await mount(backend);
    await act(async () =>
      reads[0]!({ supported: false, posture: null, hingeAngle: null, hingeRange: null }),
    );
    expect(hinge()).toBeNull();

    // The SDK's 8" Fold-out folds outward, from 180° to 360°.
    await tick();
    await act(async () =>
      reads[1]!({
        supported: true,
        posture: 'opened',
        hingeAngle: 180,
        hingeRange: { min: 180, max: 360 },
      }),
    );
    expect(hinge()).toBeNull();

    // A URL without a device follows serve-emu's default device, which can change.
    await tick();
    await act(async () => reads[2]!(fold(180, 'opened')));
    expect(hinge()).toMatchObject({ supported: true, angle: 180, pose: 'open' });
  });

  test('keeps the same hinge when a poll reads it unchanged', async () => {
    const { backend, reads } = controlledBackend();
    const { hinge, tick } = await mount(backend);
    await act(async () => reads[0]!(fold(180, 'opened')));
    const first = hinge();

    await tick();
    await act(async () => reads[1]!(fold(180, 'opened')));
    expect(hinge()).toBe(first);

    await tick();
    await act(async () => reads[2]!(fold(160, 'opened')));
    expect(hinge()).not.toBe(first);
    expect(hinge()!.angle).toBe(160);
  });

  test('shows a requested angle until serve-emu confirms it', async () => {
    const { backend, reads, writes } = controlledBackend();
    const { hinge } = await mount(backend);
    await act(async () => reads[0]!(fold(180, 'opened')));

    await act(async () => hinge()!.setControl({ control: 'angle', value: 90 }));
    expect(writes.map((write) => write.angle)).toEqual([90]);
    expect(hinge()).toMatchObject({ angle: 90, pose: 'book', pending: true });

    await act(async () => writes[0]!.resolve(fold(90)));
    expect(hinge()).toMatchObject({ angle: 90, pose: 'book', pending: false });
  });

  test('coalesces a live slider into its newest angle and lets a preset replace queued edits', async () => {
    const { backend, reads, writes } = controlledBackend();
    const { hinge } = await mount(backend);
    await act(async () => reads[0]!(fold(180, 'opened')));

    await act(async () => {
      hinge()!.setControl({ control: 'angle', value: 170 });
      hinge()!.setControl({ control: 'angle', value: 160 });
      hinge()!.setControl({ control: 'angle', value: 150 });
    });
    expect(writes.map((write) => write.angle)).toEqual([170]);
    expect(hinge()!.angle).toBe(150);

    await act(async () => writes[0]!.resolve(fold(170, 'opened')));
    expect(writes.map((write) => write.angle)).toEqual([170, 150]);

    await act(async () => {
      hinge()!.setControl({ control: 'angle', value: 120 });
      hinge()!.setControl({ control: 'pose', value: 'closed' });
    });
    await act(async () => writes[1]!.resolve(fold(150, 'opened')));
    expect(writes.map((write) => write.angle)).toEqual([170, 150, 0]);
    await act(async () => writes[2]!.resolve(fold(0, 'closed')));
    expect(hinge()).toMatchObject({ angle: 0, pose: 'closed', pending: false, activeScreenId: 1 });
  });

  test('refuses what Android cannot do without sending it', async () => {
    const { backend, reads, writes } = controlledBackend();
    const { hinge } = await mount(backend);
    await act(async () => reads[0]!(fold(90)));

    await act(async () => hinge()!.setControl({ control: 'pose', value: 'laptop' }));
    expect(hinge()!.error).toBe('The Laptop pose is not available on Android emulators.');
    await act(async () => hinge()!.setControl({ control: 'table', value: true }));
    expect(hinge()!.error).toBe('Table Mode is not available on Android emulators.');
    expect(writes).toHaveLength(0);

    await act(async () => hinge()!.setControl({ control: 'angle', value: 45 }));
    expect(hinge()!.error).toBeNull();
  });

  test('reports a refused change and returns to the confirmed angle', async () => {
    const { backend, reads, writes } = controlledBackend();
    const { hinge } = await mount(backend);
    await act(async () => reads[0]!(fold(90)));

    await act(async () => {
      hinge()!.setControl({ control: 'angle', value: 30 });
      hinge()!.setControl({ control: 'angle', value: 20 });
    });
    await act(async () => writes[0]!.reject(new Error('Emulator hinge angle change failed: KO')));
    expect(hinge()).toMatchObject({
      angle: 90,
      pending: false,
      error: 'Emulator hinge angle change failed: KO',
    });
    // The queued edit is dropped with the failure.
    expect(writes).toHaveLength(1);
  });

  test('reads the hinge again instead of trusting a reply that arrives after its timeout', async () => {
    const { hinge, reads, writes } = await mountAfterTimedOutChange();

    // The 30° change may have landed before or after the 90° one, so neither reply settles it.
    await act(async () => writes[0]!.resolve(fold(30)));
    expect(hinge()!.angle).toBe(90);
    expect(reads).toHaveLength(2);

    await act(async () => reads[1]!(fold(30)));
    expect(hinge()!.angle).toBe(30);
  });

  test('reads the hinge again after a poll that a late reply overlapped', async () => {
    const { hinge, reads, writes, tick } = await mountAfterTimedOutChange();
    await tick();
    expect(reads).toHaveLength(2);

    await act(async () => writes[0]!.reject(new Error('Android did not report a 30° hinge angle')));
    expect(reads).toHaveLength(2);
    // The poll began before the late reply, so it may describe the hinge before that change.
    await act(async () => reads[1]!(fold(90)));
    expect(reads).toHaveLength(3);
    await act(async () => reads[2]!(fold(30)));
    expect(hinge()).toMatchObject({ angle: 30, error: null });
  });

  test('ignores a poll that overlapped a change, and the results of a previous device', async () => {
    const { backend, reads, writes } = controlledBackend();
    const { hinge, tick, rerender } = await mount(backend);
    await act(async () => reads[0]!(fold(180, 'opened')));

    await tick();
    await act(async () => hinge()!.setControl({ control: 'angle', value: 90 }));
    await act(async () => writes[0]!.resolve(fold(90)));
    // The read began before the change landed, so it describes the old hinge.
    await act(async () => reads[1]!(fold(180, 'opened')));
    expect(hinge()!.angle).toBe(90);

    await act(async () => hinge()!.setControl({ control: 'angle', value: 45 }));
    const next = controlledBackend();
    await rerender(next.backend);
    await act(async () => writes[1]!.resolve(fold(45)));
    expect(hinge()).toBeNull();
    await act(async () => next.reads[0]!(fold(0, 'closed')));
    expect(hinge()).toMatchObject({ angle: 0, pending: false });
  });
});
