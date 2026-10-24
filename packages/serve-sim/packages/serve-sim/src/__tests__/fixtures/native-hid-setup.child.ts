import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";

let setupResult: "ready" | "missing-encoder" | "service-failure" = "ready";
let calls: string[] = [];
const addon = {
  SimHID: class {
    async setScreen() {
      calls.push("setScreen");
      if (setupResult === "service-failure")
        throw new Error("CoreDevice keyboard service could not be opened");
      return setupResult !== "missing-encoder";
    }
    async touch() {
      calls.push("touch");
    }
    async key() {
      calls.push("key");
    }
    async button() {
      calls.push("button");
    }
    async orientation() {
      calls.push("orientation");
      return true;
    }
    async memoryWarning() {
      calls.push("memoryWarning");
    }
  },
};
const moduleExports = await import("module");
const originalCreateRequire = moduleExports.createRequire;
mock.module("module", () => ({
  ...moduleExports,
  createRequire: (url: string | URL) => {
    const require = originalCreateRequire(url);
    return Object.assign(
      (path: string) => (path.endsWith("serve-sim-native.node") ? addon : require(path)),
      require,
    );
  },
}));
const fsExports = await import("fs");
mock.module("fs", () => ({ ...fsExports, existsSync: () => true }));
const { NativeHid } = await import("../../native");
let errors: ReturnType<typeof spyOn>;
beforeEach(() => {
  calls = [];
  setupResult = "ready";
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
});

test("service failure latches the shared gate and short-circuits later controls", async () => {
  setupResult = "service-failure";
  const hid = new NativeHid("HID-SERVICE-FAILURE-TEST");
  await hid.setScreen(1);
  expect(hid.inputUnavailable).toBe(true);
  expect(hid.keyboardUnavailable).toBe(false);
  // Even if a subsequent lookup could recover, this handle's setup is cached.
  setupResult = "ready";
  await hid.setScreen(1);
  await hid.touch("begin", 0.5, 0.5, 100, 100);
  await hid.button("home");
  expect(await hid.orientation(1)).toBe(false);
  await hid.memoryWarning();
  await hid.key("down", 4);
  await expect(hid.keyChecked("down", 4)).rejects.toThrow("Simulator input is unavailable");
  expect(calls).toEqual(["setScreen"]);
  expect(errors).toHaveBeenCalledTimes(1);

  const replacement = new NativeHid("HID-SERVICE-FAILURE-TEST");
  await replacement.setScreen(1);
  expect(replacement.inputUnavailable).toBe(false);
  await replacement.touch("begin", 0.5, 0.5, 100, 100);
  expect(calls).toEqual(["setScreen", "setScreen", "touch"]);
});

test("missing key encoder rejects keys while retaining touch and other controls", async () => {
  setupResult = "missing-encoder";
  const hid = new NativeHid("HID-MISSING-ENCODER-TEST");
  await hid.setScreen(1);
  expect(hid.inputUnavailable).toBe(false);
  expect(hid.keyboardUnavailable).toBe(true);
  await hid.touch("begin", 0.5, 0.5, 100, 100);
  await hid.button("home");
  expect(await hid.orientation(1)).toBe(true);
  await hid.memoryWarning();
  await expect(hid.key("down", 4)).rejects.toThrow("Simulator keyboard input is unavailable");
  await expect(hid.keyChecked("down", 4)).rejects.toThrow(
    "Simulator keyboard input is unavailable",
  );
  expect(calls).toEqual(["setScreen", "touch", "button", "orientation", "memoryWarning"]);
});
