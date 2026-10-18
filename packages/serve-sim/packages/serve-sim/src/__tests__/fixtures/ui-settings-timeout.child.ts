import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { installShims, useTempStateDir } from "../helpers";

const state = useTempStateDir();
const shims = installShims({ xcrun: "#!/bin/sh\nexec /bin/sleep 10\n" });
const childProcess = await import("child_process");
const realExecFile = childProcess.execFile;
const fileSystem = { ...await import("fs") };
const timeouts: number[] = [];
let hanging = true;
let keyboardUpdates = 0;

mock.module("child_process", () => ({
  ...childProcess,
  execFile(file: string, args: string[], options: { timeout?: number; encoding: "utf-8" }, callback: (error: Error | null, stdout: string, stderr: string) => void) {
    timeouts.push(options.timeout ?? 0);
    // Exercise a real subprocess timeout without spending 30 seconds per backend.
    return realExecFile(hanging ? file : "/bin/sh", hanging ? args : ["-c", "printf 42"], {
      ...options,
      timeout: hanging ? 50 : 2_000,
    }, callback);
  },
}));
mock.module("fs", () => ({
  ...fileSystem,
  existsSync: (path: string) => path.endsWith("/simax/serve-sim-ax-settings") || fileSystem.existsSync(path),
}));
mock.module("../../native", () => ({
  setHardwareKeyboard: async () => { keyboardUpdates++; return true; },
}));

const { getUiOption, setUiOption } = await import("../../ui-settings");

beforeEach(() => { timeouts.length = 0; hanging = true; keyboardUpdates = 0; });
afterAll(() => { shims.restore(); state.restore(); });

test("a boot-session timeout leaves the setting unchanged and releases its lock", async () => {
  await expect(setUiOption("FAKE-DEVICE", "hardware-keyboard", "off")).rejects.toThrow("did not finish within 30 s");
  expect(timeouts).toEqual([30_000]);
  expect(keyboardUpdates).toBe(0);
  hanging = false;
  expect(await setUiOption("FAKE-DEVICE", "hardware-keyboard", "off")).toBeString();
  expect(keyboardUpdates).toBe(1);
});

test.each(["appearance", "reduce-motion"])("bounds the %s read", async (option) => {
  await expect(getUiOption("FAKE-DEVICE", option)).rejects.toThrow("did not finish within 30 s");
  expect(timeouts).toEqual([30_000]);
});

test.each(["appearance", "reduce-motion"])("bounds the %s write", async (option) => {
  await expect(setUiOption("FAKE-DEVICE", option, option === "appearance" ? "dark" : "on")).rejects.toThrow("did not finish within 30 s");
  expect(timeouts).toEqual([30_000]);
});
