import { describe, expect, test } from "bun:test";
import { SingleDevicePolicy } from "../single-device";

const DEVICE = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const OTHER = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";

describe("single-device policy", () => {
  test("requires a concrete simulator identity", () => {
    for (const id of ["booted", "all", "iPhone", ""]) {
      expect(() => new SingleDevicePolicy(id)).toThrow();
    }
  });

  test("defaults to the pinned device and normalizes UUID case", () => {
    const policy = new SingleDevicePolicy(DEVICE.toLowerCase());
    expect(policy.resolveTarget()).toBe(DEVICE);
    expect(policy.resolveTarget(DEVICE.toLowerCase())).toBe(DEVICE);
    for (const id of [OTHER, "booted", "all", "iPhone", ""]) {
      expect(() => policy.resolveTarget(id)).toThrow("single-device");
    }
  });

  test("pins optional action targets and permits reboot of only that device", () => {
    const policy = new SingleDevicePolicy(DEVICE);
    expect(policy.scopeAction("button", { value: "home" })).toEqual({
      value: "home",
      udid: DEVICE,
    });
    expect(policy.scopeAction("capture.reboot", { udid: DEVICE, enabled: true })).toEqual({
      udid: DEVICE,
      enabled: true,
    });
    expect(() => policy.scopeAction("capture.reboot", { udid: OTHER })).toThrow();
    for (const action of ["server.detach", "server.kill", "home.watch"]) {
      expect(() => policy.scopeAction(action, {})).toThrow("single-device");
    }
  });
});
