import { asRecord, errorMessage } from "./app-permissions";
import { type DeviceFoldCapabilities } from "./types";

export type FoldFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface AndroidFoldStatus {
  supported: boolean;
  posture: "closed" | "opened" | "half_opened" | "flipped" | "tent" | null;
  hingeAngle: number | null;
}

const POSTURES = ["closed", "opened", "half_opened", "flipped", "tent"];

export function parseAndroidFold(payload: unknown): AndroidFoldStatus | null {
  const data = asRecord(payload);
  const fold = asRecord(data?.fold);
  if (data?.ok !== true || !fold || typeof fold.supported !== "boolean") return null;
  if (!fold.supported) return { supported: false, posture: null, hingeAngle: null };
  if (fold.posture !== null && !POSTURES.includes(fold.posture as string)) return null;
  if (
    fold.hingeAngle !== null &&
    (typeof fold.hingeAngle !== "number" || !Number.isFinite(fold.hingeAngle))
  )
    return null;
  return fold as unknown as AndroidFoldStatus;
}

// @ref LLP 0016#android-emulators — posture commands only; reported angles do not offer angle control
export const ANDROID_FOLD_CAPABILITIES: DeviceFoldCapabilities = {
  angle: false,
  poses: { closed: { angle: 0 }, open: { angle: 180 } },
  tableMode: false,
};

/** The signal bounds both the request and the response body, including slow adb reads. */
export async function requestAndroidFold(
  fetchImpl: FoldFetch,
  url: string,
  posture?: "closed" | "opened",
  signal?: AbortSignal,
): Promise<AndroidFoldStatus> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetchImpl(url, {
    method: posture === undefined ? "GET" : "POST",
    cache: "no-store",
    ...(posture === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ posture }),
        }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const payload: unknown = await response.json();
  const status = parseAndroidFold(payload);
  if (!response.ok || !status) {
    throw new Error(errorMessage(payload, `Fold request failed (${response.status})`));
  }
  return status;
}
