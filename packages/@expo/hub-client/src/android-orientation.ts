import { asRecord, errorMessage } from "./app-permissions";
import { DEVICE_ORIENTATIONS, isDeviceOrientation } from "./orientation";
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

export function parseAndroidOrientation(value: unknown): DeviceOrientation | null {
  return isDeviceOrientation(value) ? value : null;
}

/**
 * POST /api/orientation. Resolves the locked pose that the answer reports, or null for servers
 * that do not report one. The request's signal times out the request and its body read, as in
 * the `/api` poll.
 */
export async function writeAndroidOrientation(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  orientation: DeviceOrientation | "landscape",
  timeoutMs = ORIENTATION_REQUEST_TIMEOUT_MS,
): Promise<DeviceOrientation | null> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orientation }),
      signal,
    });
    const payload: unknown = await response.json().catch((error: unknown) => {
      if (signal.aborted) throw error;
      return null;
    });
    const data = asRecord(payload);
    if (!response.ok || data?.ok !== true) {
      throw new Error(errorMessage(payload, `Orientation change failed (${response.status})`));
    }
    return parseAndroidOrientation(asRecord(data.orientation)?.pose);
  } catch (error) {
    if (!signal.aborted) throw error;
    throw new Error(
      `The orientation change did not answer in ${timeoutMs / 1000} s. Check the device, then choose the pose again.`,
    );
  }
}

export function androidOrientationBackend(
  kind: AndroidOrientationKind,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
): DeviceOrientationBackend {
  return {
    // The URL names the server and the serial, not the token.
    device: url,
    orientations: kind === "poses" ? DEVICE_ORIENTATIONS : LEGACY_ORIENTATIONS,
    set: (orientation) =>
      writeAndroidOrientation(
        fetchImpl,
        url,
        kind === "poses" || orientation === "portrait" ? orientation : "landscape",
      ),
  };
}
