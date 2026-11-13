import { type Device, type DeviceRendering } from "@expo/hub-components";
import { useEffect, useState } from "react";

import { basePath } from "./basePath";

const REQUEST_TIMEOUT_MS = 5_000;

/** What `/api/devices/gpu` says about a running Android device. */
export type AndroidRenderingAnswer = {
  /** An emulator on this host can render on the GPU (bare-metal Apple silicon). */
  gpuAvailable: boolean;
  /** What the device renders with; `unknown` when the Hub could not read it. */
  rendering: DeviceRendering;
};

/** Parse an `/api/devices/gpu` answer; `null` for an error body. */
export function renderingAnswerFrom(body: unknown): AndroidRenderingAnswer | null {
  if (!body || typeof body !== "object") return null;
  const { gpuAvailable, renderer } = body as { gpuAvailable?: unknown; renderer?: unknown };
  if (typeof gpuAvailable !== "boolean") return null;
  const software =
    renderer && typeof renderer === "object" ? (renderer as { software?: unknown }).software : null;
  return {
    gpuAvailable,
    rendering: software === true ? "cpu" : software === false ? "gpu" : "unknown",
  };
}

/**
 * Whether the status pill warns: an emulator, on a host where emulators can
 * render on the GPU, that renders on the CPU. The pill also needs a Live stream.
 */
// @ref LLP 0024#warning — the warning needs bare-metal Apple silicon; the row shows on every host
export function showsCpuRenderingWarning(
  device: Pick<Device, "platform" | "physical"> | undefined,
  answer: AndroidRenderingAnswer | null,
): boolean {
  return (
    device?.platform === "android" &&
    !device.physical &&
    answer?.gpuAvailable === true &&
    answer.rendering === "cpu"
  );
}

/**
 * What the selected Android device renders with. Reads once each time
 * `serial` becomes ready, that is, once each time its stream starts, so a
 * restarted emulator is read again. `null` until the answer arrives, and when
 * the request fails or takes longer than 5 s. Never gives the answer for
 * another device.
 */
export function useAndroidRendering(
  serial: string | null,
  ready: boolean,
): AndroidRenderingAnswer | null {
  const [answer, setAnswer] = useState<{
    serial: string;
    answer: AndroidRenderingAnswer | null;
  } | null>(null);

  useEffect(() => {
    // A new stream may come from a restarted emulator with another renderer.
    setAnswer(null);
    if (!serial || !ready) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    void (async () => {
      try {
        const response = await fetch(
          `${basePath()}/api/devices/gpu?serial=${encodeURIComponent(serial)}`,
          { signal: controller.signal, cache: "no-store", headers: { Accept: "application/json" } },
        );
        const parsed = response.ok ? renderingAnswerFrom(await response.json()) : null;
        if (!controller.signal.aborted) setAnswer({ serial, answer: parsed });
      } catch {
        // An unknown renderer stays unknown.
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [serial, ready]);

  return serial && ready && answer?.serial === serial ? answer.answer : null;
}
