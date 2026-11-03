/**
 * A fake device host shared by the boot-admission test and its helper
 * processes. The state lives in one JSON file, so every helper process (one per
 * Hub namespace) and the test see the same simulators, adb devices and process
 * table, the way helpers on one machine see one `simctl`, `adb` and `ps`.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";

import type { HostProcess } from "../../process-table";

export interface FakeSimulator {
  name: string;
  /** simctl state: `Shutdown`, `Booting`, `Booted`, … */
  state: string;
}

/** Start time of every fake process unless it names its own, in seconds since the epoch. */
export const FAKE_STARTED = 1_798_761_600;

/** A fake process: its command line, or the line with its own start time or `ps` state. */
export type FakeProcess =
  | string
  | { args: string; started?: number; state?: string; ppid?: number };

/** The process table `ps` would list for these processes, keyed by pid. */
export function fakeProcessTable(
  processes: Iterable<[number | string, FakeProcess]>,
): HostProcess[] {
  return [...processes].map(([pid, process]) => {
    const {
      args,
      started = FAKE_STARTED,
      state = "S",
      ppid = 1,
    } = typeof process === "string" ? { args: process } : process;
    return { pid: Number(pid), ppid, state, started, args };
  });
}

export interface FakeAdbDevice {
  /** AVD name, reported only while the emulator is online; `null` for physical devices. */
  avdName: string | null;
  /** adb state: `device`, `offline`, `unauthorized`, … */
  state: string;
}

/** How the next Android boot behaves. */
export interface FakeAndroidScenario {
  /** Port `freeEmulatorPort` returns; `null` makes the allocation fail. */
  port: number | null;
  /** `bootDevice` fails without starting a process. */
  spawnError: boolean;
  /** The emulator process exits with this code before it comes online. */
  exitCode: number | null;
  /** `waitForAdbOnline` gives up (`false`) instead of seeing the serial online. */
  neverOnline: boolean;
  /** `waitForAdbOnline` fails with an error. */
  waitError: boolean;
  /** pid of the next spawned emulator process. */
  pid: number;
}

export interface FakeHostState {
  simulators: Record<string, FakeSimulator>;
  adb: Record<string, FakeAdbDevice>;
  /** The process table: command line by pid. The test adds each helper it starts. */
  processes: Record<string, string>;
  /** Listing the native devices fails. */
  occupancyError: boolean;
  /** `simctl boot` fails after the simulator started booting. */
  iosBootFails: boolean;
  /** UDID `simctl create` returns; `null` makes the create fail. */
  iosCreateUdid: string | null;
  android: FakeAndroidScenario;
}

export function initialFakeHost(): FakeHostState {
  return {
    simulators: {},
    adb: {},
    processes: {},
    occupancyError: false,
    iosBootFails: false,
    iosCreateUdid: null,
    android: {
      port: 5560,
      spawnError: false,
      exitCode: null,
      neverOnline: false,
      waitError: false,
      pid: 4_100_001,
    },
  };
}

export function readFakeHost(file: string): FakeHostState {
  return JSON.parse(readFileSync(file, "utf8")) as FakeHostState;
}

/** Replace the state atomically, so a reader never sees a partial file. */
export function writeFakeHost(file: string, state: FakeHostState): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, file);
}

export function updateFakeHost(file: string, update: (state: FakeHostState) => void): void {
  const state = readFakeHost(file);
  update(state);
  writeFakeHost(file, state);
}

/** Messages a helper process sends to the test over IPC. */
export type HelperMessage =
  | { type: "ready" }
  /** The fake platform boot started: the native boot step executed. */
  | { type: "boot-started"; device: string }
  /** The admission read the native occupancy. */
  | { type: "occupancy-read" }
  | { type: "result"; result: { ok: boolean; id?: string; error?: string; errors: unknown[] } };

/** Messages the test sends to a helper process. */
export type HelperCommand =
  | {
      type: "boot";
      request: { platform: "ios" | "android"; id: string; name: string };
      /** Block the fake boot after its milestone until `release`. */
      hold?: boolean;
    }
  | {
      type: "create";
      request: { platform: "ios" | "android"; name: string; runtime: string; deviceType: string };
    }
  | { type: "release" }
  | { type: "exit" };
