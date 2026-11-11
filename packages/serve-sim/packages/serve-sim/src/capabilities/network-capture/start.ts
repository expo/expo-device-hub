import { captureRuntime, CaptureEnableError } from "./runtime";
import type { CaptureMeta } from "./store";

type CaptureStartMeta = Pick<CaptureMeta, "proxyAddress">;

export interface StartCaptureDeps {
  shouldStop?: () => boolean;
  enable?: (udid: string) => Promise<CaptureStartMeta>;
  onStarted?: (meta: CaptureStartMeta) => void;
  onFailed?: (reason: string) => void;
}

export async function startCaptureForDevice(
  udid: string,
  deps: StartCaptureDeps = {},
): Promise<void> {
  if (deps.shouldStop?.()) return;
  try {
    const meta = await (deps.enable ?? captureRuntime.enableForDevice)(udid);
    // Shutdown that began meanwhile tears this session down; do not announce it as running.
    if (deps.shouldStop?.()) return;
    deps.onStarted?.(meta);
  } catch (error) {
    const reason =
      error instanceof CaptureEnableError
        ? error.meta.attachError
        : error instanceof Error
          ? error.message
          : String(error);
    deps.onFailed?.(reason ?? "Unknown capture startup failure");
  }
}

/**
 * Start capture on a list of devices, once per process. The CLI's main command starts capture
 * before it launches apps, and serve() asks again while it sets the preview up. A device whose start
 * failed here is not tried a second time in the same process: that would wait out the proxy's
 * startup once more and print the same failure twice. A device that is capturing is left alone, and
 * one whose session started and then lost its proxy reads as failed without being in the set, so
 * the second call replaces that session.
 */
export function createCaptureStarter(
  runtime: Pick<typeof captureRuntime, "metaFor"> = captureRuntime,
): (udids: string[], depsFor?: (udid: string) => StartCaptureDeps) => Promise<void> {
  const failedStarts = new Set<string>();
  return async (udids, depsFor = () => ({})) => {
    for (const udid of udids) {
      if (runtime.metaFor(udid).attachment === "capturing" || failedStarts.has(udid)) continue;
      const deps = depsFor(udid);
      await startCaptureForDevice(udid, {
        ...deps,
        onFailed: (reason) => {
          failedStarts.add(udid);
          deps.onFailed?.(reason);
        },
      });
    }
  };
}
