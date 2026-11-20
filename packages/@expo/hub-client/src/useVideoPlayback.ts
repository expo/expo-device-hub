import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DevicePlayback } from "./types";
import { observeVideoPlayback } from "./video-playback";

const IDLE = { state: "idle", error: null } as const;

/** The adapter owns the attached surface, including hidden Duo texture sources. */
export function useVideoPlayback(
  video: HTMLVideoElement | null,
  source: MediaStream | null,
  enabled: boolean,
  isCurrent?: () => boolean,
): DevicePlayback | undefined {
  const ownership = useRef({ video, source, enabled, isCurrent });
  ownership.current = { video, source, enabled, isCurrent };
  const controller = useRef<{
    video: HTMLVideoElement;
    source: MediaStream;
    observer: ReturnType<typeof observeVideoPlayback>;
  } | null>(null);
  const [snapshot, setSnapshot] = useState<{
    video: HTMLVideoElement | null;
    source: MediaStream | null;
    state: DevicePlayback["state"];
    error: string | null;
  }>({ video: null, source: null, ...IDLE });
  useEffect(() => {
    if (!enabled || !video || !source) return;
    const observer = observeVideoPlayback(
      video,
      (next) => setSnapshot({ video, source, ...next }),
      source,
      () => {
        const owner = ownership.current;
        return (
          owner.enabled &&
          owner.video === video &&
          owner.source === source &&
          (owner.isCurrent?.() ?? true)
        );
      },
    );
    controller.current = { video, source, observer };
    return () => {
      observer.dispose();
      controller.current = null;
    };
  }, [video, source, enabled]);
  const resume = useCallback(() => {
    const current = controller.current;
    return enabled && current?.video === video && current.source === source
      ? current.observer.resume()
      : Promise.resolve();
  }, [video, source, enabled]);
  const current = snapshot.video === video && snapshot.source === source ? snapshot : IDLE;
  return useMemo(
    () => (enabled ? { state: current.state, error: current.error, resume } : undefined),
    [enabled, current, resume],
  );
}
