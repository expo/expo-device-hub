/// <reference types="bun" />

/**
 * One Hub helper process for the boot-admission test: a separate Hub namespace
 * that boots devices through the real `bootHubDevice`/`createHubDevice` while
 * the platform utilities act on the fake host in `BOOT_ADMISSION_FAKE_HOST`.
 * The test drives it over IPC and hears each milestone back.
 */

import { mock, spyOn } from "bun:test";

import type {
  AndroidUtilsResult,
  BootDeviceOptions,
  BootedDevice,
  EmulatorExit,
} from "@expo/hub-android-utils";
import type { AppleUtilsResult } from "@expo/hub-apple-utils";

import type { BootAdmission, NativeOccupancy } from "../../boot-admission";
import type { EmulatorCameraFeeds } from "../../device-actions";
import {
  type HelperCommand,
  type HelperMessage,
  fakeProcessTable,
  readFakeHost,
  updateFakeHost,
} from "./boot-admission-fake-host";

const hostFile = requiredEnv("BOOT_ADMISSION_FAKE_HOST");
const policyFile = requiredEnv("BOOT_ADMISSION_POLICY_FILE");
const stateDir = requiredEnv("BOOT_ADMISSION_STATE_DIR");

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function send(message: HelperMessage): void {
  process.send?.(message);
}

// The AVD the current Android boot is starting; `adb emu avd name` reports it once online.
let lastAvdName: string | null = null;
let hold: Promise<void> | null = null;
let release: (() => void) | null = null;

/** Report the boot milestone, then wait for the test when it asked to hold this boot. */
async function bootMilestone(device: string): Promise<void> {
  send({ type: "boot-started", device });
  if (hold) await hold;
}

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function failure(message: string) {
  return { message, error: new Error(message) };
}

// Fake emulator pids (4_100_001 and up) are within Linux's pid range, so a
// signal acts on the fake host only: signal 0 checks it, any other ends it.
const fakePidExists = (pid: number) => String(pid) in readFakeHost(hostFile).processes;
spyOn(process, "kill").mockImplementation((pid, signal) => {
  if (!fakePidExists(pid)) {
    throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
  }
  if (signal !== 0) {
    updateFakeHost(hostFile, (state) => {
      delete state.processes[String(pid)];
    });
  }
  return true;
});

const androidUtils = await import("@expo/hub-android-utils");
mock.module("@expo/hub-android-utils", () => ({
  ...androidUtils,
  freeEmulatorPort: async (): Promise<AndroidUtilsResult<number | null>> => {
    const { port } = readFakeHost(hostFile).android;
    return port === null
      ? { value: null, error: failure("adb devices failed") }
      : { value: port, error: null };
  },
  bootDevice: async (
    options: BootDeviceOptions,
  ): Promise<AndroidUtilsResult<BootedDevice | null>> => {
    await bootMilestone(options.name);
    const scenario = readFakeHost(hostFile).android;
    if (scenario.spawnError) return { value: null, error: failure("emulator binary missing") };

    const serial = `emulator-${options.port}`;
    updateFakeHost(hostFile, (state) => {
      state.adb[serial] ??= { avdName: null, state: "offline" };
      if (scenario.exitCode === null) {
        state.processes[String(scenario.pid)] =
          `emulator -avd ${options.name} -port ${options.port}`;
      }
    });
    const exited: Promise<EmulatorExit> =
      scenario.exitCode === null
        ? pending()
        : Promise.resolve({ code: scenario.exitCode, signal: null, error: null });
    return {
      value: { serial, pid: scenario.pid, command: `emulator -avd ${options.name}`, exited },
      error: null,
    };
  },
  waitForAdbOnline: async (serial: string): Promise<AndroidUtilsResult<string | null>> => {
    const host = readFakeHost(hostFile);
    const scenario = host.android;
    // An emulator that exits never comes online; the exit wins the race.
    if (scenario.exitCode !== null) return pending();
    if (scenario.waitError) return { value: null, error: failure("adb devices failed") };
    if (scenario.neverOnline) return { value: null, error: null };
    // Like the real wait, report the AVD that came online at the serial.
    const avdName = host.adb[serial]?.avdName ?? lastAvdName;
    updateFakeHost(hostFile, (state) => {
      state.adb[serial] = { avdName, state: "device" };
    });
    return { value: avdName, error: null };
  },
  createDevice: async (): Promise<AndroidUtilsResult<boolean>> => ({ value: true, error: null }),
}));

const appleUtils = await import("@expo/hub-apple-utils");
mock.module("@expo/hub-apple-utils", () => ({
  ...appleUtils,
  bootDevice: async ({ udid }: { udid: string }): Promise<AppleUtilsResult<boolean>> => {
    await bootMilestone(udid);
    const fails = readFakeHost(hostFile).iosBootFails;
    updateFakeHost(hostFile, (state) => {
      const simulator = state.simulators[udid];
      // A failed `simctl boot` can still leave the simulator booting.
      if (simulator) simulator.state = fails ? "Booting" : "Booted";
    });
    return fails
      ? { value: false, error: failure("simctl boot failed") }
      : { value: true, error: null };
  },
  createDevice: async ({ name }: { name: string }): Promise<AppleUtilsResult<string | null>> => {
    const udid = readFakeHost(hostFile).iosCreateUdid;
    if (!udid) return { value: null, error: failure("simctl create failed") };
    updateFakeHost(hostFile, (state) => {
      state.simulators[udid] = { name, state: "Shutdown" };
    });
    return { value: udid, error: null };
  },
}));

const actions = await import("../../device-actions");

// On the base source boot-admission.ts does not exist. Falling back to no
// admission keeps this fixture loadable there, so the cross-process regression
// fails by its refusal assertion on the old code instead of by a load error.
const admissionModule = await import("../../boot-admission").catch((error: unknown) => {
  if (String(error).includes("Cannot find module")) return undefined;
  throw error;
});

const admission: BootAdmission | undefined = admissionModule?.createBootAdmission({
  policyFile,
  stateDir,
  host: {
    async readOccupancy() {
      send({ type: "occupancy-read" });
      const state = readFakeHost(hostFile);
      if (state.occupancyError) {
        return {
          value: null,
          error: { id: "fake", message: "adb devices failed", error: "Error: adb" },
        };
      }
      const occupancy: NativeOccupancy = {
        simulators: Object.entries(state.simulators).map(([udid, simulator]) => ({
          udid,
          ...simulator,
        })),
        androidDevices: Object.entries(state.adb).map(([serial, device]) => ({
          serial,
          ...device,
        })),
      };
      return { value: occupancy, error: null };
    },
    async readProcesses() {
      return {
        value: fakeProcessTable(Object.entries(readFakeHost(hostFile).processes)),
        error: null,
      };
    },
    pidExists: fakePidExists,
  },
});

const cameraFeeds: EmulatorCameraFeeds = {
  launchArgs: () => [],
  seedPlaceholders: async () => {},
};

process.on("message", async (command: HelperCommand) => {
  if (command.type === "exit") process.exit(0);
  if (command.type === "release") {
    release?.();
    return;
  }

  if (command.request.platform === "android") lastAvdName = command.request.name || null;
  if (command.type === "create") {
    send({
      type: "result",
      result: await actions.createHubDevice(command.request, cameraFeeds, admission),
    });
    return;
  }
  if (command.hold) {
    hold = new Promise((resolve) => {
      release = () => {
        hold = null;
        resolve();
      };
    });
  }
  send({
    type: "result",
    result: await actions.bootHubDevice(command.request, cameraFeeds, admission),
  });
});

send({ type: "ready" });
