import { bootDevice, shutdownDevice } from "../device";
import { devicesArmedHere, rearmCapabilityLoader } from "../launch-manager";
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

// launchctl values do not survive a reboot, so a device this process armed needs arming again.
// A failure rejects the reboot: reporting success would hide that apps lost their capabilities.
async function rearmCapabilities(udid: string): Promise<void> {
  if (devicesArmedHere().includes(udid)) await rearmCapabilityLoader(udid);
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
  try {
    return await attempt;
  } finally {
    if (inFlight.get(udid) === entry) inFlight.delete(udid);
  }
}
