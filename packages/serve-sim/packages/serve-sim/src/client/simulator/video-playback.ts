export type VideoPlaybackIssue = "blocked" | "error" | null;

/**
 * Autoplay permission is separate from stream health. Keep the owned video and
 * let a trusted click start it without reconnecting the peer or sending input.
 */
export function observeVideoPlayback(
  video: HTMLVideoElement,
  onIssue: (issue: VideoPlaybackIssue) => void,
) {
  let disposed = false;
  let attempt = 0;
  const owns = (id: number, source: HTMLVideoElement["srcObject"]) =>
    !disposed && id === attempt && video.srcObject === source;
  const play = () => {
    const source = video.srcObject;
    if (disposed || !source) return;
    const id = ++attempt;
    // Keep this call synchronous: Safari requires play() in the click's gesture.
    void video.play().then(
      () => {
        if (owns(id, source)) onIssue(video.paused ? "blocked" : null);
      },
      (error: unknown) => {
        if (!owns(id, source)) return;
        const name = (error as { name?: string } | null)?.name;
        // Replacing a stream interrupts play; its metadata event starts the new one.
        if (name === "AbortError") return;
        onIssue(name === "NotAllowedError" ? "blocked" : "error");
      },
    );
  };
  const playing = () => {
    if (video.paused) return;
    ++attempt;
    onIssue(null);
  };
  const paused = () => {
    if (video.srcObject && video.paused && !video.ended) onIssue("blocked");
  };
  const emptied = () => {
    ++attempt;
    onIssue(null);
  };
  const visible = () => {
    if (!document.hidden && video.paused) play();
  };
  video.addEventListener("loadedmetadata", play);
  video.addEventListener("playing", playing);
  video.addEventListener("pause", paused);
  video.addEventListener("emptied", emptied);
  document.addEventListener("visibilitychange", visible);
  if (video.srcObject) play();
  return {
    play,
    dispose() {
      disposed = true;
      ++attempt;
      video.removeEventListener("loadedmetadata", play);
      video.removeEventListener("playing", playing);
      video.removeEventListener("pause", paused);
      video.removeEventListener("emptied", emptied);
      document.removeEventListener("visibilitychange", visible);
    },
  };
}
