import { type GpuWarningInfo } from "@expo/hub-components";
import { useEffect, useState } from "react";

import { basePath } from "./basePath";

const REQUEST_TIMEOUT_MS = 5_000;

/** The warning for an `/api/devices/gpu` answer, or `null` when it has none. */
export function gpuWarningFrom(body: unknown): GpuWarningInfo | null {
  if (!body || typeof body !== "object") return null;
  const { gpuAvailable, renderer } = body as { gpuAvailable?: unknown; renderer?: unknown };
  if (gpuAvailable !== true || !renderer || typeof renderer !== "object") return null;
  const { name, software } = renderer as { name?: unknown; software?: unknown };
  return software === true && typeof name === "string" && name ? { renderer: name } : null;
}

/**
 * Whether the selected emulator renders on the CPU although this host has a
 * usable GPU. Reads once each time `serial` becomes ready, that is, once each
 * time its stream starts, so a restarted emulator is read again. A failed read
 * shows no warning. Never shows the answer for another emulator.
 */
export function useEmulatorGpuWarning(
  serial: string | null,
  ready: boolean,
): GpuWarningInfo | null {
  const [answer, setAnswer] = useState<{ serial: string; warning: GpuWarningInfo | null } | null>(
    null,
  );

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
        const warning = response.ok ? gpuWarningFrom(await response.json()) : null;
        if (!controller.signal.aborted) setAnswer({ serial, warning });
      } catch {
        // An unknown renderer shows no warning.
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [serial, ready]);

  return serial && ready && answer?.serial === serial ? answer.warning : null;
}
