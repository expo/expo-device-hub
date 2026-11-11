import { describe, expect, test } from "bun:test";

import { createDisplayOrientationReader } from "../src/display-orientation.ts";
import type { ScreenOrientation } from "../src/shared/api-contracts.ts";

function reader(readings: Array<ScreenOrientation | Error | Promise<ScreenOrientation>>) {
  let time = 0;
  let reads = 0;
  const {
    reader: instance,
    locking,
    locked,
  } = createDisplayOrientationReader({
    read: async () => {
      const next = readings[Math.min(reads++, readings.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
    now: () => time,
  });
  return {
    instance,
    locking,
    locked,
    advance: (ms: number) => (time += ms),
    reads: () => reads,
  };
}

function deferred() {
  let resolve: (pose: ScreenOrientation) => void = () => {};
  const promise = new Promise<ScreenOrientation>((done) => (resolve = done));
  return { promise, resolve };
}

describe("display orientation reader", () => {
  test("reports null until the first reading, then reads again only after a second", async () => {
    const { instance, advance, reads } = reader(["landscape_right", "landscape_left"]);
    expect(instance.current()).toBeNull();
    await expect(instance.fresh()).resolves.toBe("landscape_right");
    advance(999);
    expect(instance.current()).toBe("landscape_right");
    expect(reads()).toBe(1);
    advance(2);
    // A stale reading starts a new one in the background and returns the last value.
    expect(instance.current()).toBe("landscape_right");
    expect(reads()).toBe(2);
    await expect(instance.fresh()).resolves.toBe("landscape_left");
  });

  test("shares one query between concurrent reads and keeps the last value on failure", async () => {
    const { instance, advance, reads } = reader(["portrait_upside_down", new Error("adb offline")]);
    const [first, second] = await Promise.all([instance.fresh(), instance.fresh()]);
    expect([first, second]).toEqual(["portrait_upside_down", "portrait_upside_down"]);
    expect(reads()).toBe(1);
    advance(1_001);
    await expect(instance.fresh()).resolves.toBe("portrait_upside_down");
  });

  test("waits for a new reading once the last one is stale, but only for a moment", async () => {
    const { instance, advance, reads } = reader(["portrait", "landscape_right"]);
    await expect(instance.fresh()).resolves.toBe("portrait");
    await expect(instance.fresh()).resolves.toBe("portrait");
    expect(reads()).toBe(1);
    advance(1_001);
    await expect(instance.fresh()).resolves.toBe("landscape_right");
  });

  test("returns the last reading when a new one takes longer than 300 ms", async () => {
    const slow = deferred();
    const { instance, advance } = reader(["portrait", slow.promise]);
    await instance.fresh();
    advance(1_001);
    const startedAt = performance.now();
    await expect(instance.fresh()).resolves.toBe("portrait");
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(250);
    slow.resolve("landscape_right");
    await Promise.resolve();
    await expect(instance.fresh()).resolves.toBe("landscape_right");
  });

  test("a lock replaces the reading at once and discards a read that started before it", async () => {
    const old = deferred();
    const { instance, locked, advance, reads } = reader(["portrait", old.promise]);
    await instance.fresh();
    advance(1_001);
    expect(instance.current()).toBe("portrait");
    locked("landscape_left");
    // The pre-lock read answers later with the pre-lock pose.
    old.resolve("portrait");
    await Promise.resolve();
    advance(200);
    await expect(instance.fresh()).resolves.toBe("landscape_left");
    expect(instance.current()).toBe("landscape_left");
    expect(reads()).toBe(2);
  });

  test("after a free rotation, a new caller does not get the result of a read from before it", async () => {
    const old = deferred();
    const { instance, locked, advance } = reader(["portrait", old.promise, "landscape_right"]);
    await instance.fresh();
    advance(1_001);
    expect(instance.current()).toBe("portrait");
    locked(null);
    const next = instance.fresh();
    old.resolve("portrait");
    await expect(next).resolves.toBe("landscape_right");
  });
});

test("observe reads now, never reports a commanded or failed reading, and updates the cache", async () => {
  const { instance, locked, reads } = reader(["portrait", "landscape_left", new Error("offline")]);
  await expect(instance.observe()).resolves.toMatchObject({ orientation: "portrait" });
  expect(instance.current()).toBe("portrait");
  expect(reads()).toBe(1);
  // Each call starts its own read instead of sharing the last one.
  const turned = instance.observe();
  locked("portrait");
  await expect(turned).resolves.toBeNull();
  expect(instance.current()).toBe("portrait");
  await expect(instance.observe()).resolves.toBeNull();
  expect(reads()).toBe(3);
});

test("an older shared read never replaces a newer observation", async () => {
  const old = deferred();
  const { instance, advance } = reader([old.promise, "landscape_right"]);
  const shared = instance.fresh();
  advance(10);
  await expect(instance.observe()).resolves.toMatchObject({ orientation: "landscape_right" });
  old.resolve("portrait");
  await shared;
  expect(instance.current()).toBe("landscape_right");
});

test("observe drops readings while a lock command is in flight", async () => {
  const pending = deferred();
  const { instance, locking, locked } = reader(["portrait", pending.promise, "landscape_left"]);
  const before = await instance.observe();
  expect(before).toMatchObject({ orientation: "portrait" });
  const overlapping = instance.observe();
  locking();
  await expect(instance.observe()).resolves.toBeNull();
  pending.resolve("landscape_left");
  await expect(overlapping).resolves.toBeNull();
  locked("landscape_left");
  const after = await instance.observe();
  expect(after).toMatchObject({ orientation: "landscape_left" });
  // The lock command between the two readings shows in their generations.
  expect(after!.generation).not.toBe(before!.generation);
});
