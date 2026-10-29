import { describe, expect, test } from "bun:test";

import type { DisplayRotation } from "../src/adb.ts";
import { createDisplayOrientationReader } from "../src/display-orientation.ts";

type Size = { width: number; height: number };
const PHONE = { width: 1080, height: 2400 };
const TABLET = { width: 2560, height: 1600 };

function reader(
  rotations: Array<DisplayRotation | Error | Promise<DisplayRotation>>,
  sizes: Size[] = [PHONE],
) {
  let time = 0;
  let rotationReads = 0;
  let sizeReads = 0;
  const instance = createDisplayOrientationReader("emulator-5554", {
    readRotation: async () => {
      const next = rotations[Math.min(rotationReads++, rotations.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
    readNaturalSize: async () => sizes[Math.min(sizeReads++, sizes.length - 1)],
    now: () => time,
  });
  return {
    instance,
    advance: (ms: number) => (time += ms),
    reads: () => ({ rotationReads, sizeReads }),
  };
}

describe("display orientation reader", () => {
  test("reports null until the first reading, then reads again only after a second", async () => {
    const { instance, advance, reads } = reader([1, 3]);
    expect(instance.current()).toBeNull();
    await instance.refresh();
    expect(instance.current()).toBe("landscape_right");
    advance(999);
    expect(instance.current()).toBe("landscape_right");
    expect(reads().rotationReads).toBe(1);
    advance(2);
    // A stale reading starts a new one in the background and returns the last value.
    expect(instance.current()).toBe("landscape_right");
    expect(reads().rotationReads).toBe(2);
    await instance.refresh();
    expect(instance.current()).toBe("landscape_left");
  });

  test("shares one query between concurrent reads and keeps the last value on failure", async () => {
    const { instance, advance, reads } = reader([2, new Error("adb offline")]);
    const [first, second] = await Promise.all([instance.refresh(), instance.refresh()]);
    expect([first, second]).toEqual(["portrait_upside_down", "portrait_upside_down"]);
    expect(reads().rotationReads).toBe(1);
    advance(1_001);
    await expect(instance.refresh()).resolves.toBe("portrait_upside_down");
  });

  test("names a tablet's natural landscape display landscape_right", async () => {
    const { instance } = reader([0], [TABLET]);
    await expect(instance.refresh()).resolves.toBe("landscape_right");
  });

  test("reads the natural size again, so a tablet that reuses a phone's serial is named right", async () => {
    const { instance, reads } = reader([0], [PHONE, TABLET]);
    await expect(instance.refresh()).resolves.toBe("portrait");
    await expect(instance.refresh()).resolves.toBe("landscape_right");
    expect(reads()).toEqual({ rotationReads: 2, sizeReads: 2 });
  });

  test("waits for a new reading once the last one is stale, but only for a moment", async () => {
    const { instance, advance, reads } = reader([0, 1]);
    await expect(instance.fresh()).resolves.toBe("portrait");
    await expect(instance.fresh()).resolves.toBe("portrait");
    expect(reads().rotationReads).toBe(1);
    advance(1_001);
    await expect(instance.fresh()).resolves.toBe("landscape_right");
  });

  test("returns the last reading when a new one takes longer than 300 ms", async () => {
    let finish: (rotation: DisplayRotation) => void = () => {};
    const slow = new Promise<DisplayRotation>((resolve) => (finish = resolve));
    const { instance, advance } = reader([0, slow]);
    await instance.refresh();
    advance(1_001);
    const startedAt = performance.now();
    await expect(instance.fresh()).resolves.toBe("portrait");
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(250);
    finish(1);
    await expect(instance.refresh()).resolves.toBe("landscape_right");
  });

  test("a lock replaces the reading at once and discards a read that started before it", async () => {
    let finishOld: (rotation: DisplayRotation) => void = () => {};
    const old = new Promise<DisplayRotation>((resolve) => (finishOld = resolve));
    const { instance, advance, reads } = reader([0, old]);
    await instance.refresh();
    advance(1_001);
    const before = instance.refresh();
    instance.locked("landscape_left");
    // The pre-lock read answers later with the pre-lock rotation.
    finishOld(0);
    await before;
    advance(200);
    await expect(instance.fresh()).resolves.toBe("landscape_left");
    expect(instance.current()).toBe("landscape_left");
    expect(reads().rotationReads).toBe(2);
  });

  test("after a free rotation, the next read waits for an older read instead of sharing it", async () => {
    let finishOld: (rotation: DisplayRotation) => void = () => {};
    const old = new Promise<DisplayRotation>((resolve) => (finishOld = resolve));
    const { instance, advance, reads } = reader([0, old, 1]);
    await instance.refresh();
    advance(1_001);
    void instance.refresh();
    instance.locked(null);
    const next = instance.refresh();
    expect(reads().rotationReads).toBe(2);
    finishOld(0);
    await expect(next).resolves.toBe("landscape_right");
    expect(reads().rotationReads).toBe(3);
  });
});
