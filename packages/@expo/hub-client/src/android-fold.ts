import { asRecord, errorMessage } from "./app-permissions";
import { type DeviceFoldCapabilities } from "./types";

export type FoldFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface AndroidFoldStatus {
  supported: boolean;
  posture: "closed" | "opened" | "half_opened" | "flipped" | "tent" | null;
  hingeAngle: number | null;
  hingeRange: { min: number; max: number } | null;
}

const POSTURES = ["closed", "opened", "half_opened", "flipped", "tent"];

export function parseAndroidFold(payload: unknown): AndroidFoldStatus | null {
  const data = asRecord(payload);
  const fold = asRecord(data?.fold);
  if (data?.ok !== true || !fold || typeof fold.supported !== "boolean") return null;
  if (!fold.supported)
    return { supported: false, posture: null, hingeAngle: null, hingeRange: null };
  if (fold.posture !== null && !POSTURES.includes(fold.posture as string)) return null;
  if (
    fold.hingeAngle !== null &&
    (typeof fold.hingeAngle !== "number" || !Number.isFinite(fold.hingeAngle))
  )
    return null;
  const range = asRecord(fold.hingeRange);
  const min = range?.min;
  const max = range?.max;
  const hingeRange =
    typeof min === "number" &&
    Number.isFinite(min) &&
    typeof max === "number" &&
    Number.isFinite(max) &&
    min < max
      ? { min, max }
      : null;
  return {
    supported: true,
    posture: fold.posture as AndroidFoldStatus["posture"],
    hingeAngle: fold.hingeAngle as number | null,
    hingeRange,
  };
}

// @ref LLP 0016#android-emulators — only offer the verified range and the poses Android can apply
export const ANDROID_FOLD_CAPABILITIES: DeviceFoldCapabilities = {
  angle: { min: 0, max: 180 },
  poses: { closed: { angle: 0 }, book: { angle: 90 }, open: { angle: 180 } },
  tableMode: false,
};

export function androidFoldCapabilities(status: AndroidFoldStatus | null): DeviceFoldCapabilities {
  return status?.supported && status.hingeRange?.min === 0 && status.hingeRange.max === 180
    ? ANDROID_FOLD_CAPABILITIES
    : false;
}

export function androidFoldPose(angle: number | undefined) {
  return angle === undefined
    ? undefined
    : angle === 0
      ? ("closed" as const)
      : angle === 90
        ? ("book" as const)
        : angle === 180
          ? ("open" as const)
          : null;
}

export function sameAndroidFold(a: AndroidFoldStatus | null, b: AndroidFoldStatus): boolean {
  return (
    !!a &&
    a.supported === b.supported &&
    a.posture === b.posture &&
    a.hingeAngle === b.hingeAngle &&
    a.hingeRange?.min === b.hingeRange?.min &&
    a.hingeRange?.max === b.hingeRange?.max
  );
}

/** The signal bounds both the request and the response body, including slow adb reads. */
export async function requestAndroidFold(
  fetchImpl: FoldFetch,
  url: string,
  angle?: number,
  signal?: AbortSignal,
): Promise<AndroidFoldStatus> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetchImpl(url, {
    method: angle === undefined ? "GET" : "POST",
    cache: "no-store",
    ...(angle === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hingeAngle: angle }),
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
