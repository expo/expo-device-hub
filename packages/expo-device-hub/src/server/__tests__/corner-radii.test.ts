import { beforeEach, describe, expect, mock, test } from "bun:test";

import { androidCornerRadii, appleCornerRadii, clearCornerRadiiCache } from "../corner-radii";

const radii = { topLeft: 0.1, topRight: 0.1, bottomRight: 0.1, bottomLeft: 0.1 };
const booted = { serial: "emulator-5554", name: "Pixel_9", booted: true };

beforeEach(clearCornerRadiiCache);

describe("appleCornerRadii", () => {
  test("reads each device type once", async () => {
    const read = mock(async () => ({ value: radii }));

    expect(await appleCornerRadii("type-a", read)).toEqual(radii);
    expect(await appleCornerRadii("type-a", read)).toEqual(radii);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("skips devices without a device type", async () => {
    const read = mock(async () => ({ value: radii }));

    expect(await appleCornerRadii(null, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("androidCornerRadii", () => {
  test("does not ask a device that is not booted", async () => {
    const read = mock(async () => ({ value: radii }));

    expect(await androidCornerRadii({ ...booted, booted: false }, read)).toBeNull();
    expect(await androidCornerRadii({ ...booted, serial: null }, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  test("keeps radii that a device reported", async () => {
    const read = mock(async () => ({ value: radii }));

    await androidCornerRadii(booted, read, 0);
    expect(await androidCornerRadii(booted, read, 60_000)).toEqual(radii);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("asks again after the retry delay when a device reported none", async () => {
    const read = mock(async () => ({ value: null }));

    await androidCornerRadii(booted, read, 0);
    await androidCornerRadii(booted, read, 5_000);
    expect(read).toHaveBeenCalledTimes(1);

    await androidCornerRadii(booted, read, 10_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  test("treats a failed read as no radii", async () => {
    const read = mock(async () => {
      throw new Error("adb failed");
    });

    expect(await androidCornerRadii(booted, read, 0)).toBeNull();
  });

  test("does not reuse radii for another AVD on the same serial", async () => {
    const read = mock(async () => ({ value: radii }));

    await androidCornerRadii(booted, read, 0);
    await androidCornerRadii({ ...booted, name: "Pixel_10_Pro" }, read, 0);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
