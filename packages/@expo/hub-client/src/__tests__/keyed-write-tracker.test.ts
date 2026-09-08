import { describe, expect, test } from "bun:test";

import { KeyedWriteTracker } from "../keyed-write-tracker";
import { type DeviceSettingKey } from "../types";

describe("KeyedWriteTracker", () => {
  test("allows different options concurrently while rejecting a repeated write to the same option", () => {
    const tracker = new KeyedWriteTracker<DeviceSettingKey>();

    const appearance = tracker.start("appearance");
    const textSize = tracker.start("text-size");

    expect(appearance).not.toBeNull();
    expect(textSize).not.toBeNull();
    expect(tracker.start("appearance")).toBeNull();
    expect(tracker.pending).toEqual(new Set(["appearance", "text-size"]));

    expect(tracker.finish(appearance!)).toBeTrue();
    expect(tracker.pending).toEqual(new Set(["text-size"]));
    expect(tracker.finish(textSize!)).toBeTrue();
    expect(tracker.pending).toEqual(new Set());
  });

  test("invalidates stale completions when the active device changes", () => {
    const tracker = new KeyedWriteTracker<DeviceSettingKey>();
    const oldDeviceRequest = tracker.start("appearance")!;

    tracker.reset();
    const newDeviceRequest = tracker.start("appearance")!;

    expect(tracker.isCurrent(oldDeviceRequest)).toBeFalse();
    expect(tracker.finish(oldDeviceRequest)).toBeFalse();
    expect(tracker.pending).toEqual(new Set(["appearance"]));
    expect(tracker.isCurrent(newDeviceRequest)).toBeTrue();
  });
});
