import { bootDevice, confirmDeviceBooted, shutdownDevice } from "./device";
import { retireDeviceSession } from "./device-session";
import { captureRuntime } from "./capture";
import { releaseSession } from "./launch-manager";
import { stopCameraHelper } from "./camera-helper";
import {
  clearServeSimState,
  gridDeviceState,
  writeServeSimState,
  type StreamSettings,
} from "./state";

/** Shared by UI device selection and private adoption; callbacks supply session-specific setup. */
export async function startDeviceInProcess(
  udid: string,
  port: number,
  base: string,
  streamSettings?: StreamSettings,
  sessionToken?: string,
  onBoot?: () => Promise<void>,
  options: { signal?: AbortSignal; requireReady?: boolean } = {},
): Promise<void> {
  const { signal } = options;
  signal?.throwIfAborted();
  await bootDevice(udid, { allowBootedRecovery: !options.requireReady });
  signal?.throwIfAborted();
  await onBoot?.();
  signal?.throwIfAborted();
  writeServeSimState(gridDeviceState(udid, port, base, streamSettings, sessionToken));
}

/** Stop local consumers and the device; private adoption also checks and releases its ownership. */
export async function stopDeviceInProcess(udid: string, ownerPid?: number): Promise<void> {
  await retireDeviceSession(udid);
  // The grid keeps its existing capture-cleanup retry; private adoption must drain before shutdown.
  if (ownerPid === undefined) await shutdownDevice(udid);
  else {
    await captureRuntime.disableForDevice(udid);
    await releaseSession(
      udid,
      ownerPid,
      (capability) => {
        if (capability.name === "camera") stopCameraHelper(udid);
      },
      { shutdown: true },
    );
  }
  clearServeSimState(udid, ownerPid ?? process.pid);
}

/**
 * Runs `prepare` unless this process already prepared `udid`. A prepared device only passes the
 * boot readiness check again; if it is no longer booted, it is prepared again. Only a successful
 * preparation counts.
 */
export async function prepareDeviceOnce(
  udid: string,
  preparedDevices: Set<string>,
  prepare: () => Promise<void>,
): Promise<void> {
  const key = udid.toUpperCase();
  if (preparedDevices.has(key)) {
    try {
      await confirmDeviceBooted(udid);
      return;
    } catch (error) {
      console.error(
        `Simulator ${udid} failed its boot check; preparing it again: ${error instanceof Error ? error.message : String(error)}`,
      );
      preparedDevices.delete(key);
    }
  }
  await prepare();
  preparedDevices.add(key);
}

/**
 * Unpublishes `udids` at once, then shuts them down in the background. Resolves with the
 * shutdown failures, which are also logged; the launcher's stop confirms every shutdown.
 */
export function retireDevicesInBackground(
  udids: readonly string[],
  ownerPid: number,
  preparedDevices: Set<string>,
  // A boot already started by warmup must finish before its device shuts down.
  warmup: Promise<unknown> = Promise.resolve(),
): Promise<unknown[]> {
  for (const udid of udids) {
    preparedDevices.delete(udid.toUpperCase());
    clearServeSimState(udid, ownerPid);
  }
  return (async () => {
    await warmup.catch(() => {});
    const failures: unknown[] = [];
    for (const udid of udids) {
      try {
        await stopDeviceInProcess(udid, ownerPid);
      } catch (error) {
        failures.push(error);
        console.error(
          `Could not shut down Simulator ${udid}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return failures;
  })();
}
