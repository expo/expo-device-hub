import { asRecord, errorMessage } from "./app-permissions";
import { DEVICE_ORIENTATIONS } from "./orientation";
import { type DeviceOrientation } from "./types";
import { type DeviceOrientationBackend } from "./useDeviceOrientation";

/**
 * `poses`: the server reports `orientation` in `/api` and locks every pose. `legacy`: an older
 * server that only takes `portrait` and `landscape`, which locks rotation 1, a phone turned a
 * quarter turn counterclockwise (`landscape_right`).
 */
export type AndroidOrientationKind = "poses" | "legacy";

const LEGACY_ORIENTATIONS: readonly DeviceOrientation[] = ["portrait", "landscape_right"];
/** `POST /api/orientation` locks with adb, which can take a few seconds. */
const ORIENTATION_REQUEST_TIMEOUT_MS = 10_000;
const ORIENTATION_TIMEOUT_MESSAGE =
  "The orientation change did not answer in 10 s. Check the device, then choose the pose again.";

export function parseAndroidOrientation(value: unknown): DeviceOrientation | null {
  return DEVICE_ORIENTATIONS.find((orientation) => orientation === value) ?? null;
}

/**
 * POST /api/orientation. Resolves the locked pose that the answer reports, or null for servers
 * that do not report one. One deadline covers the request and its body.
 */
export async function writeAndroidOrientation(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  orientation: DeviceOrientation | "landscape",
  timeoutMs = ORIENTATION_REQUEST_TIMEOUT_MS,
): Promise<DeviceOrientation | null> {
  const signal = AbortSignal.timeout(timeoutMs);
  // The deadline also ends a body read that does not watch the request's signal.
  const deadline = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orientation }),
        signal,
      }),
      deadline,
    ]);
    const payload: unknown = await Promise.race([
      response.json().catch((error: unknown) => {
        if (signal.aborted) throw error;
        return null;
      }),
      deadline,
    ]);
    const data = asRecord(payload);
    if (!response.ok || data?.ok !== true) {
      throw new Error(errorMessage(payload, `Orientation change failed (${response.status})`));
    }
    return parseAndroidOrientation(asRecord(data.orientation)?.pose);
  } catch (error) {
    if (signal.aborted) throw new Error(ORIENTATION_TIMEOUT_MESSAGE);
    throw error;
  }
}

export function androidOrientationBackend(
  kind: AndroidOrientationKind,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
): DeviceOrientationBackend {
  return {
    orientations: kind === "poses" ? DEVICE_ORIENTATIONS : LEGACY_ORIENTATIONS,
    set: (orientation) =>
      writeAndroidOrientation(
        fetchImpl,
        url,
        kind === "poses" || orientation === "portrait" ? orientation : "landscape",
      ),
  };
}
