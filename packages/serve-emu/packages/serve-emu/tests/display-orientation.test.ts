import { describe, expect, test } from "bun:test";

import type { DisplayRotation } from "../src/adb.ts";
import { createDisplayOrientationReader } from "../src/display-orientation.ts";

function reader(
  rotations: Array<DisplayRotation | Error>,
  natural = { width: 1080, height: 2400 },
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
    readNaturalSize: async () => {
      sizeReads++;
      return natural;
    },
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
    expect(instance.current()).toBe("landscape_left");
    advance(999);
    expect(instance.current()).toBe("landscape_left");
    expect(reads().rotationReads).toBe(1);
    advance(2);
    instance.current();
    await instance.refresh();
    expect(instance.current()).toBe("landscape_right");
    expect(reads()).toEqual({ rotationReads: 2, sizeReads: 1 });
  });

  test("shares one query between concurrent reads and keeps the last value on failure", async () => {
    const { instance, advance, reads } = reader([2, new Error("adb offline")]);
    const [first, second] = await Promise.all([instance.refresh(), instance.refresh()]);
    expect([first, second]).toEqual(["portrait_upside_down", "portrait_upside_down"]);
    expect(reads().rotationReads).toBe(1);
    advance(1_001);
    await expect(instance.refresh()).resolves.toBe("portrait_upside_down");
  });

  test("names a tablet's natural landscape display landscape_left", async () => {
    const { instance } = reader([0], { width: 2560, height: 1600 });
    await expect(instance.refresh()).resolves.toBe("landscape_left");
  });

  test("waits for a new reading once the last one is stale, but only for a moment", async () => {
    const { instance, advance, reads } = reader([0, 1]);
    await expect(instance.fresh()).resolves.toBe("portrait");
    await expect(instance.fresh()).resolves.toBe("portrait");
    expect(reads().rotationReads).toBe(1);
    advance(1_001);
    await expect(instance.fresh()).resolves.toBe("landscape_left");
  });
});
