import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEmulator } from "../src/emulator.ts";
import { cameraLaunchArgs, readCameraStatus } from "../src/camera.ts";
import type { execText } from "../src/exec.ts";

const unwired = async () => false;

function result(stdout = "") {
  return { status: 0, signal: null, stdout, stderr: "", timedOut: false, error: null };
}

function bootingExec(): typeof execText {
  return (async (command, args) => {
    if (command === "/sdk/emulator") return result("Pixel_8\n");
    const adbCommand = (args as string[]).slice(2).join(" ");
    if (adbCommand === "get-state") return result("device\n");
    if (adbCommand === "shell getprop sys.boot_completed") return result("1\n");
    if (adbCommand === "emu kill") return result("");
    if (adbCommand === "emu avd name") return result("Other_Avd\n");
    if (adbCommand === "shell getprop ro.boot.qemu.avd_name") return result("Other_Avd\n");
    throw new Error(`unexpected adb command: ${adbCommand}`);
  }) as typeof execText;
}

function fakeSpawn(calls: unknown[][]) {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcess;
  return ((command: string, args: string[], options: unknown) => {
    calls.push([command, args, options]);
    return proc;
  }) as unknown as typeof spawn;
}

let root: string;
const previousRoot = process.env.SERVE_EMU_CAMERA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "serve-emu-emulator-camera-"));
  process.env.SERVE_EMU_CAMERA_DIR = root;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.SERVE_EMU_CAMERA_DIR;
  else process.env.SERVE_EMU_CAMERA_DIR = previousRoot;
  await rm(root, { recursive: true, force: true });
});

describe("startEmulator camera wiring", () => {
  test("attaches both imagefile feeds and seeds them before spawning", async () => {
    const spawnCalls: unknown[][] = [];
    const launch = await startEmulator(
      {
        avd: "Pixel_8",
        emulatorPath: "/sdk/emulator",
        port: 5560,
        gpu: "host",
        camera: true,
      },
      {
        execText: bootingExec(),
        listAllDevices: async () => [],
        spawn: fakeSpawn(spawnCalls),
      },
    );

    expect(launch.cameraFeed).toBe(true);
    expect(spawnCalls[0]?.[1]).toEqual([
      "@Pixel_8",
      "-port",
      "5560",
      "-gpu",
      "host",
      ...cameraLaunchArgs("emulator-5560"),
    ]);

    const status = await readCameraStatus("emulator-5560", unwired);
    expect(status.feeds.every((feed) => feed.placeholder)).toBe(true);
  });

  test("leaves the camera flags off by default", async () => {
    const spawnCalls: unknown[][] = [];
    const launch = await startEmulator(
      { avd: "Pixel_8", emulatorPath: "/sdk/emulator", port: 5560 },
      {
        execText: bootingExec(),
        listAllDevices: async () => [],
        spawn: fakeSpawn(spawnCalls),
      },
    );

    expect(launch.cameraFeed).toBe(false);
    expect(spawnCalls[0]?.[1]).toEqual(["@Pixel_8", "-port", "5560"]);
    const status = await readCameraStatus("emulator-5560", unwired);
    expect(status.feeds.every((feed) => feed.present)).toBe(false);
  });

  test("reports no feed when it reuses an already running AVD", async () => {
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      const adbCommand = (args as string[]).slice(2).join(" ");
      if (adbCommand === "emu avd name") return result("Pixel_8\n");
      throw new Error(`unexpected adb command: ${adbCommand}`);
    }) as typeof execText;

    const launch = await startEmulator(
      { avd: "Pixel_8", emulatorPath: "/sdk/emulator", camera: true },
      {
        execText: runExec,
        listAllDevices: async () => [{ serial: "emulator-5554", state: "device" }],
        spawn: fakeSpawn([]),
      },
    );

    expect(launch).toMatchObject({
      serial: "emulator-5554",
      ownsProcess: false,
      cameraFeed: false,
    });
  });
});
