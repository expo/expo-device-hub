import type { DevicePlayback } from "./types";

type PlaybackSnapshot = Pick<DevicePlayback, "state" | "error">;

/** Own only browser playback, without replacing the peer or forwarding device input. */
export function observeVideoPlayback(
  video: HTMLVideoElement,
  onChange: (snapshot: PlaybackSnapshot) => void,
  expectedSource = video.srcObject,
  isCurrent: () => boolean = () => true,
) {
  let disposed = false;
  let attempt = 0;
  const owns = (id: number, source: HTMLVideoElement["srcObject"]) =>
    !disposed &&
    isCurrent() &&
    id === attempt &&
    source === expectedSource &&
    video.srcObject === source;
  const update = (state: DevicePlayback["state"], error: string | null = null) =>
    onChange({ state, error });
  const resume = (): Promise<void> => {
    const source = video.srcObject;
    if (disposed || !isCurrent() || !source || source !== expectedSource) return Promise.resolve();
    const id = ++attempt;
    const failed = (error: unknown) => {
      if (!owns(id, source)) return;
      const name = (error as { name?: string } | null)?.name;
      if (name === "AbortError") return;
      update(
        name === "NotAllowedError" ? "blocked" : "error",
        error instanceof Error ? error.message : "Live video could not start.",
      );
    };
    try {
      update("starting");
      // Stay inside the trusted user action; never await before calling play().
      const pending = video.play();
      return pending.then(() => {
        if (owns(id, source)) update(video.paused ? "blocked" : "playing");
      }, failed);
    } catch (error) {
      failed(error);
      return Promise.resolve();
    }
  };
  const playing = () => {
    if (disposed || !isCurrent() || video.srcObject !== expectedSource || video.paused) return;
    ++attempt;
    update("playing");
  };
  const paused = () => {
    if (
      !disposed &&
      isCurrent() &&
      video.srcObject === expectedSource &&
      video.srcObject &&
      video.paused &&
      !video.ended
    )
      update("blocked");
  };
  const emptied = () => {
    ++attempt;
    update("idle");
  };
  const visible = () => {
    if (!document.hidden && video.paused) void resume();
  };
  video.addEventListener("loadedmetadata", resume);
  video.addEventListener("playing", playing);
  video.addEventListener("pause", paused);
  video.addEventListener("emptied", emptied);
  document.addEventListener("visibilitychange", visible);
  if (video.srcObject) void resume();
  return {
    resume,
    dispose() {
      disposed = true;
      ++attempt;
      video.removeEventListener("loadedmetadata", resume);
      video.removeEventListener("playing", playing);
      video.removeEventListener("pause", paused);
      video.removeEventListener("emptied", emptied);
      document.removeEventListener("visibilitychange", visible);
    },
  };
}
