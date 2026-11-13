import { type EmulatorRendering } from "@expo/hub-components";
import { useEffect, useState } from "react";

import { basePath } from "./basePath";

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * What an `/api/devices/gpu` answer says the emulator renders with. `null`
 * when the host has no GPU that an emulator can use (the server then does not
 * read the renderer) or when the renderer is unknown.
 */
export function renderingFrom(body: unknown): EmulatorRendering | null {
  if (!body || typeof body !== "object") return null;
  const { gpuAvailable, renderer } = body as { gpuAvailable?: unknown; renderer?: unknown };
  if (gpuAvailable !== true || !renderer || typeof renderer !== "object") return null;
  const { software } = renderer as { software?: unknown };
  return software === true ? "cpu" : software === false ? "gpu" : null;
}

/**
 * What the selected emulator renders with, on a host whose GPU an emulator can
 * use. Reads once each time `serial` becomes ready, that is, once each time its
 * stream starts, so a restarted emulator is read again. A failed read gives
 * `null`. Never gives the answer for another emulator.
 */
export function useEmulatorRendering(
  serial: string | null,
  ready: boolean,
): EmulatorRendering | null {
  const [answer, setAnswer] = useState<{
    serial: string;
    rendering: EmulatorRendering | null;
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
        const rendering = response.ok ? renderingFrom(await response.json()) : null;
        if (!controller.signal.aborted) setAnswer({ serial, rendering });
      } catch {
        // An unknown renderer shows nothing.
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [serial, ready]);

  return serial && ready && answer?.serial === serial ? answer.rendering : null;
}
