import { afterEach, describe, expect, test } from "bun:test";
import {
  DEVICE_DISCONNECTED_REASON,
  WS_CLOSE_DEVICE_ENDED,
  clearDeviceEnd,
  deviceEndConfig,
  deviceEndReason,
  recordDeviceEnd,
} from "../device-end";

const PHONE = "00008101-0016603236F0801E";

afterEach(() => clearDeviceEnd(PHONE));

describe("deviceEndReason", () => {
  test("names a disconnected device the way serve-sim's viewers show it", () => {
    expect(deviceEndReason({ reason: "device-disconnected" })).toBe("iPhone disconnected");
    expect(DEVICE_DISCONNECTED_REASON).toBe("iPhone disconnected");
  });

  test("keeps the native message of another end, with a fallback", () => {
    expect(deviceEndReason({ reason: "capture-failed", message: "Screen capture stopped" })).toBe(
      "Screen capture stopped",
    );
    expect(deviceEndReason({ reason: "capture-failed" })).toBe("The device stream ended");
  });
});

describe("the ended-device record", () => {
  test("answers discovery for the device until a new start clears it", () => {
    expect(deviceEndConfig(PHONE)).toBeNull();

    recordDeviceEnd(PHONE.toLowerCase(), DEVICE_DISCONNECTED_REASON);

    expect(deviceEndConfig(PHONE)).toEqual({
      device: PHONE,
      ended: { reason: "iPhone disconnected" },
    });
    clearDeviceEnd(PHONE);
    expect(deviceEndConfig(PHONE)).toBeNull();
  });

  test("closes viewers' input sockets with a code outside the reserved range", () => {
    expect(WS_CLOSE_DEVICE_ENDED).toBeGreaterThanOrEqual(4000);
    expect(WS_CLOSE_DEVICE_ENDED).toBeLessThan(5000);
  });
});
