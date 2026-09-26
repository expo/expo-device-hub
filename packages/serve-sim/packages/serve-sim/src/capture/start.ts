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
