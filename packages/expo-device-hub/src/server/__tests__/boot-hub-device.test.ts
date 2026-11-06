import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AndroidUtilsResult,
  BootDeviceOptions,
  BootedDevice,
  EmulatorExit,
} from "@expo/hub-android-utils";

import { bootHubDevice, shutdownHubDevice, type EmulatorCameraFeeds } from "../device-actions";

const calls: string[] = [];
const signals: { pid: number; signal: string | number | undefined }[] = [];
let killSpy: ReturnType<typeof spyOn<typeof process, "kill">>;

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function feedArgs(serial: string): string[] {
  return ["-camera-back", `imagefile:/feeds/${serial}-back.png`];
}

interface Scenario {
  port: number | null;
  spawned: BootDeviceOptions | null;
  exited: Promise<EmulatorExit>;
  online: Promise<AndroidUtilsResult<string | null>>;
  shutdownOk: boolean;
}

const scenario: Scenario = {
  port: 5560,
  spawned: null,
  exited: pending(),
  online: Promise.resolve({ value: "Pixel_9", error: null }),
  shutdownOk: true,
};

const androidUtils = await import("@expo/hub-android-utils");

mock.module("@expo/hub-android-utils", () => ({
  ...androidUtils,
  freeEmulatorPort: async () => {
    calls.push("freeEmulatorPort");
    return { value: scenario.port, error: null };
  },
  bootDevice: async (options: BootDeviceOptions) => {
    calls.push(`spawn ${options.name}`);
    scenario.spawned = options;
    const booted: BootedDevice = {
      serial: `emulator-${options.port}`,
      pid: 4242,
      command: `emulator -avd ${options.name}`,
      exited: scenario.exited,
    };
    return { value: booted, error: null };
  },
  waitForAdbOnline: (serial: string) => {
    calls.push(`waitForAdbOnline ${serial}`);
    return scenario.online;
  },
  shutdownDevice: async ({ serial }: { serial: string }) => {
    calls.push(`shutdownDevice ${serial}`);
    return { value: scenario.shutdownOk, error: null };
  },
  waitForAdbOffline: async (serial: string) => {
    calls.push(`waitForAdbOffline ${serial}`);
    return { value: true, error: null };
  },
  removeDevice: async ({ name }: { name: string }) => {
    calls.push(`removeDevice ${name}`);
    return { value: true, error: null };
  },
  createDevice: async () => ({ value: true, error: null }),
}));

function cameraFeeds(seedFailure?: Error): EmulatorCameraFeeds {
  return {
    launchArgs(serial) {
      calls.push(`launchArgs ${serial}`);
      return feedArgs(serial);
    },
    async seedPlaceholders(serial) {
      calls.push(`seedPlaceholders ${serial}`);
      if (seedFailure) throw seedFailure;
    },
  };
}

function bootRequest() {
  return { platform: "android" as const, id: "", name: "Pixel_9" };
}

beforeEach(() => {
  calls.length = 0;
  scenario.port = 5560;
  scenario.spawned = null;
  scenario.exited = pending();
  scenario.online = Promise.resolve({ value: "Pixel_9", error: null });
  scenario.shutdownOk = true;
  signals.length = 0;
  killSpy = spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
    signals.push({ pid, signal });
    return true;
  });
});

afterEach(() => {
  killSpy.mockRestore();
});

describe("bootHubDevice camera feeds", () => {
  test("seeds the allocated serial before it spawns the emulator", async () => {
    const result = await bootHubDevice(bootRequest(), cameraFeeds());

    expect(calls).toEqual([
      "freeEmulatorPort",
      "seedPlaceholders emulator-5560",
      "launchArgs emulator-5560",
      "spawn Pixel_9",
      "waitForAdbOnline emulator-5560",
    ]);
    expect(result).toEqual({
      ok: true,
      id: "emulator-5560",
      serial: "emulator-5560",
      errors: [],
    });
  });

  test("spawns with the launch args for the allocated serial", async () => {
    scenario.port = 5570;

    await bootHubDevice(bootRequest(), cameraFeeds());

    expect(scenario.spawned).toEqual({
      name: "Pixel_9",
      port: 5570,
      extraArgs: feedArgs("emulator-5570"),
    });
  });

  test("boots without camera feeds when seeding fails", async () => {
    const result = await bootHubDevice(bootRequest(), cameraFeeds(new Error("disk full")));

    expect(calls).toEqual([
      "freeEmulatorPort",
      "seedPlaceholders emulator-5560",
      "spawn Pixel_9",
      "waitForAdbOnline emulator-5560",
    ]);
    expect(scenario.spawned?.extraArgs).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.errors[0]?.message).toBe("Failed to prepare camera feeds for Pixel_9");
  });
});

describe("bootHubDevice emulator identity", () => {
  test("fails when another AVD already holds the allocated serial", async () => {
    scenario.online = Promise.resolve({ value: "j5-tester-1", error: null });

    const result = await bootHubDevice(
      { platform: "android", id: "", name: "j5-tester-2" },
      cameraFeeds(),
    );

    expect(result.ok).toBe(false);
    expect(result.id).toBeUndefined();
    expect(result.serial).toBeUndefined();
    expect(result.error).toContain('"j5-tester-1"');
    expect(result.error).toContain('"j5-tester-2"');
    expect(result.error).toContain("5560");
  });

  test("stops only the emulator process it spawned, never the serial's owner", async () => {
    scenario.online = Promise.resolve({ value: "j5-tester-1", error: null });

    await bootHubDevice({ platform: "android", id: "", name: "j5-tester-2" }, cameraFeeds());

    expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(calls).not.toContain("shutdownDevice emulator-5560");
  });

  test("reports an emulator it could not stop", async () => {
    scenario.online = Promise.resolve({ value: "j5-tester-1", error: null });
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });

    const result = await bootHubDevice(
      { platform: "android", id: "", name: "j5-tester-2" },
      cameraFeeds(),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not be stopped");
    expect(result.errors.map((error) => error.message)).toEqual([
      "Failed to stop the emulator spawned for j5-tester-2",
    ]);
  });

  test("treats an emulator that already exited as stopped", async () => {
    scenario.online = Promise.resolve({ value: "j5-tester-1", error: null });
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });

    const result = await bootHubDevice(
      { platform: "android", id: "", name: "j5-tester-2" },
      cameraFeeds(),
    );

    expect(result.error).toContain("was told to stop");
    expect(result.errors).toEqual([]);
  });

  test("leaves the emulator running when the requested AVD comes online", async () => {
    const result = await bootHubDevice(bootRequest(), cameraFeeds());

    expect(result).toEqual({
      ok: true,
      id: "emulator-5560",
      serial: "emulator-5560",
      errors: [],
    });
    expect(signals).toEqual([]);
  });

  test("leaves the emulator running when the wait times out", async () => {
    scenario.online = Promise.resolve({ value: null, error: null });

    const result = await bootHubDevice(bootRequest(), cameraFeeds());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Timed out waiting for the emulator to come online");
    expect(signals).toEqual([]);
  });
});

describe("bootHubDevice emulator capture", () => {
  const library = "/opt/capture/libexpo_emulator_capture.dylib";
  const socketDirectory = join(tmpdir(), "hub-boot-capture-test");
  const capture = {
    library: async () => {
      calls.push("library");
      return library;
    },
    problem: () => null,
    socketDirectory,
    platform: "darwin" as const,
  };

  test("preloads the agent with a per-serial socket and log, and host rendering", async () => {
    await mkdir(socketDirectory, { recursive: true });
    await chmod(socketDirectory, 0o700);
    await writeFile(join(socketDirectory, "emulator-5560.log"), "capture disabled: old\n");
    await bootHubDevice(bootRequest(), cameraFeeds(), capture);

    expect(scenario.spawned).toEqual({
      name: "Pixel_9",
      port: 5560,
      extraArgs: [...feedArgs("emulator-5560"), "-gpu", "host"],
      env: {
        DYLD_INSERT_LIBRARIES: library,
        EXPO_EMULATOR_CAPTURE_SOCKET: join(socketDirectory, "emulator-5560.sock"),
        EXPO_EMULATOR_CAPTURE_LOG: join(socketDirectory, "emulator-5560.log"),
      },
    });
    // A log from an earlier emulator on this serial is gone before the boot.
    expect(existsSync(join(socketDirectory, "emulator-5560.log"))).toBe(false);
    // The agent comes first: two boots during the install must not get the same port.
    expect(calls.indexOf("library")).toBeLessThan(calls.indexOf("freeEmulatorPort"));
  });

  test("still preloads the agent when camera seeding fails", async () => {
    await bootHubDevice(bootRequest(), cameraFeeds(new Error("disk full")), capture);

    expect(scenario.spawned?.extraArgs).toEqual(["-gpu", "host"]);
    expect(scenario.spawned?.env?.DYLD_INSERT_LIBRARIES).toBe(library);
  });

  test("boots without the agent when another user could write its socket directory", async () => {
    const shared = join(tmpdir(), "hub-boot-capture-shared");
    await mkdir(shared, { recursive: true });
    await chmod(shared, 0o755);
    const result = await bootHubDevice(bootRequest(), cameraFeeds(), {
      ...capture,
      socketDirectory: shared,
    });

    expect(scenario.spawned?.env).toBeUndefined();
    expect(scenario.spawned?.extraArgs).toEqual([...feedArgs("emulator-5560"), "-gpu", "host"]);
    expect(result.errors[0]?.message).toBe("Pixel_9 starts without the emulator capture agent");
    expect(JSON.stringify(result.errors[0])).toContain("only this user can access");
  });

  test("boots without the agent, and says so, when the agent package is not installed", async () => {
    const result = await bootHubDevice(bootRequest(), cameraFeeds(), {
      ...capture,
      library: async () => {
        throw new Error("npm install expo-emulator-capture@0.1.0 failed: E404");
      },
    });

    expect(scenario.spawned?.env).toBeUndefined();
    // The renderer follows the feature, not the install.
    expect(scenario.spawned?.extraArgs).toEqual([...feedArgs("emulator-5560"), "-gpu", "host"]);
    expect(result.ok).toBe(true);
    expect(result.errors[0]?.message).toBe("Pixel_9 starts without the emulator capture agent");
  });
});

describe("shutdownHubDevice", () => {
  test("waits for the emulator to go offline after the shutdown", async () => {
    const result = await shutdownHubDevice({
      platform: "android",
      id: "emulator-5560",
      name: "Pixel_9",
    });

    expect(calls).toEqual(["shutdownDevice emulator-5560", "waitForAdbOffline emulator-5560"]);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("does not wait for adb when the shutdown itself fails", async () => {
    scenario.shutdownOk = false;

    const result = await shutdownHubDevice({
      platform: "android",
      id: "emulator-5560",
      name: "Pixel_9",
    });

    expect(calls).toEqual(["shutdownDevice emulator-5560"]);
    expect(result.ok).toBe(false);
  });
});
