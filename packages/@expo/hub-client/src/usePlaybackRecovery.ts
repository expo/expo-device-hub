import { useEffect } from "react";
import type { DeviceClient, DevicePlayback } from "./types";

const handlers = new WeakMap<DevicePlayback["resume"], number>();
const warned = new WeakSet<DevicePlayback["resume"]>();

/** Register the consumer's recovery presentation; unsupported clients return null. */
export function usePlaybackRecovery(client: Pick<DeviceClient, "playback">): DevicePlayback | null {
  const playback = client.playback ?? null;
  const resume = playback?.resume;
  useEffect(() => {
    if (!resume) return;
    handlers.set(resume, (handlers.get(resume) ?? 0) + 1);
    return () => {
      const count = (handlers.get(resume) ?? 1) - 1;
      if (count) handlers.set(resume, count);
      else handlers.delete(resume);
    };
  }, [resume]);
  return playback;
}

/** Warn only for the presented client's playback, not inactive Duo panels. */
export function usePlaybackRecoveryWarning(playback: DevicePlayback | undefined) {
  useEffect(() => {
    if (
      process.env.NODE_ENV !== "development" ||
      !playback ||
      (playback.state !== "blocked" && playback.state !== "error")
    )
      return;
    const timer = setTimeout(() => {
      if (!handlers.has(playback.resume) && !warned.has(playback.resume)) {
        warned.add(playback.resume);
        console.warn(
          "WebRTC playback needs recovery. Render usePlaybackRecovery(client) outside hidden or inert stream wrappers and call playback.resume() from a user action.",
        );
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [playback]);
}
