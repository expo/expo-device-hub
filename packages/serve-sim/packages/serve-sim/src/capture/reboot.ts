import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bootDevice, shutdownDevice } from "../device";
import { devicesArmedHere, rearmCapabilityLoader } from "../launch-manager";
import { stateDir } from "../state";
import { CaptureEnableError, captureRuntime, type CaptureRuntime } from "./runtime";
import { type CaptureField } from "./fields";
import { type CaptureMeta } from "./store";

export interface RebootDeps {
  runtime?: CaptureRuntime;
  /** Close the device's preview session (its capture and HID) before the device shuts down. */
  closeSession?: (udid: string) => void | Promise<void>;
  shutdown?: (udid: string) => Promise<void>;
  boot?: (udid: string) => Promise<void>;
  rearm?: (udid: string) => Promise<void>;
}

type InFlight = { request: string; promise: Promise<CaptureMeta> };
const inFlight = new Map<string, InFlight>();
const latestRequest = new Map<string, string>();

/** Two reboots with the same key end in the same state, so one can join the other. */
function rebootRequestKey(enabled: boolean, fields: readonly CaptureField[]): string {
  return enabled ? `on:${[...fields].sort().join(",")}` : "off";
}

type RebootRecord = { pid: number; endedAt?: number };

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function rebootRecordFile(udid: string): string {
  return join(stateDir(), `reboot-${udid}.json`);
}

function writeRebootRecord(udid: string, record: RebootRecord): void {
  const file = rebootRecordFile(udid);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, file);
  } catch {}
}

// launchctl values do not survive a reboot, so a device this process armed needs arming again.
// A failure rejects the reboot: reporting success would hide that apps lost their capabilities.
async function rearmCapabilities(udid: string): Promise<void> {
  if (devicesArmedHere().includes(udid)) await rearmCapabilityLoader(udid);
}

/**
 * Whether a capture reboot, in any serve-sim process, was running at or after `since` (ms). The
 * reboot shuts the device down on purpose, so a boot-state snapshot from that window must not be
 * read as the device being gone.
 */
export function rebootedWithCaptureSince(udid: string, since: number): boolean {
  if (inFlight.has(udid)) return true;
  let record: RebootRecord;
  try {
    record = JSON.parse(readFileSync(rebootRecordFile(udid), "utf-8")) as RebootRecord;
  } catch {
    return false;
  }
  return record.endedAt === undefined ? isProcessAlive(record.pid) : record.endedAt >= since;
}

/** Tear down the old session first so injection cannot point the new boot at a dead port. */
export async function rebootWithCapture(
  udid: string,
  enabled: boolean,
  deps: RebootDeps = {},
  /** What the new session keeps instead of the server's default; only used when enabling. */
  fields?: readonly CaptureField[],
): Promise<CaptureMeta> {
  const runtime = deps.runtime ?? captureRuntime;
  // Resolved now, so an omitted list and the same list given explicitly share one reboot.
  const sessionFields = fields ?? runtime.defaultFields();
  const request = rebootRequestKey(enabled, sessionFields);
  latestRequest.set(udid, request);
  // Serialize per device. The same state and fields join; anything else waits, then runs unless a
  // newer request asked for something else while it waited.
  for (;;) {
    const running = inFlight.get(udid);
    if (!running) break;
    if (running.request === request) return running.promise;
    await running.promise.catch(() => {});
    if (latestRequest.get(udid) !== request) return runtime.metaFor(udid);
  }

  // Loaded when a reboot runs: the CLI imports this module at startup, and the device session
  // loads the native capture and HID code.
  const closeSession = deps.closeSession ?? (async (id: string) => (await import("../device-session")).closeDeviceSession(id));
  const shutdown = deps.shutdown ?? shutdownDevice;
  const boot = deps.boot ?? bootDevice;
  const rearm = deps.rearm ?? rearmCapabilities;

  const attempt = (async () => {
    // Reconnecting the preview during reboot must not start capture early.
    runtime.setDeviceCaptureEnabled(udid, false);
    try {
      await runtime.disableForDevice(udid);
      // As the preview's shutdown control does: a session kept across the reboot would hold the
      // previous boot's CoreDevice and HID state, and input (Duo taps) would stop reaching the app.
      await closeSession(udid);
      await shutdown(udid);
      await boot(udid);
      await rearm(udid);
      if (!enabled) return runtime.metaFor(udid);
      try {
        return await runtime.enableForDevice(udid, sessionFields);
      } catch (error) {
        if (error instanceof CaptureEnableError) return error.meta;
        throw error;
      }
    } finally {
      runtime.setDeviceCaptureEnabled(udid, enabled);
    }
  })();
  const entry: InFlight = { request, promise: attempt };
  inFlight.set(udid, entry);
  writeRebootRecord(udid, { pid: process.pid });
  try {
    return await attempt;
  } finally {
    if (inFlight.get(udid) === entry) inFlight.delete(udid);
    writeRebootRecord(udid, { pid: process.pid, endedAt: Date.now() });
  }
}
