import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bootDevice, shutdownDevice } from "../device";
import { devicesArmedHere, rearmCapabilityLoader } from "../launch-manager";
import { stateDir } from "../state";
import { CaptureEnableError, captureRuntime, type CaptureRuntime } from "./runtime";
import { type CaptureMeta } from "./store";

export interface RebootDeps {
  runtime?: CaptureRuntime;
  shutdown?: (udid: string) => Promise<void>;
  boot?: (udid: string) => Promise<void>;
  rearm?: (udid: string) => Promise<void>;
}

type InFlight = { enabled: boolean; promise: Promise<CaptureMeta> };
const inFlight = new Map<string, InFlight>();
const latestIntent = new Map<string, boolean>();

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
): Promise<CaptureMeta> {
  const runtime = deps.runtime ?? captureRuntime;
  latestIntent.set(udid, enabled);
  // Serialize per device. Same intent joins; opposite intent waits, then runs unless a newer
  // request asked for the other state while it waited.
  for (;;) {
    const running = inFlight.get(udid);
    if (!running) break;
    if (running.enabled === enabled) return running.promise;
    await running.promise.catch(() => {});
    if (latestIntent.get(udid) !== enabled) return runtime.metaFor(udid);
  }

  const shutdown = deps.shutdown ?? shutdownDevice;
  const boot = deps.boot ?? bootDevice;
  const rearm = deps.rearm ?? rearmCapabilities;

  const attempt = (async () => {
    // Reconnecting the preview during reboot must not start capture early.
    runtime.setDeviceCaptureEnabled(udid, false);
    try {
      await runtime.disableForDevice(udid);
      await shutdown(udid);
      await boot(udid);
      await rearm(udid);
      if (!enabled) return runtime.metaFor(udid);
      try {
        return await runtime.enableForDevice(udid);
      } catch (error) {
        if (error instanceof CaptureEnableError) return error.meta;
        throw error;
      }
    } finally {
      runtime.setDeviceCaptureEnabled(udid, enabled);
    }
  })();
  const entry: InFlight = { enabled, promise: attempt };
  inFlight.set(udid, entry);
  writeRebootRecord(udid, { pid: process.pid });
  try {
    return await attempt;
  } finally {
    if (inFlight.get(udid) === entry) inFlight.delete(udid);
    writeRebootRecord(udid, { pid: process.pid, endedAt: Date.now() });
  }
}
