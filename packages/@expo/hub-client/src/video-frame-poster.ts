/**
 * Copy a video's current frame into its `poster`, so the frame stays on screen
 * after its stream detaches. An existing poster is kept until fresh video
 * paints over it. Returns whether the video now has a poster; canvas capture
 * is best effort.
 */
export function preserveVideoFrame(video: HTMLVideoElement): boolean {
  if (!video.poster && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    try {
      const snapshot = document.createElement("canvas");
      snapshot.width = video.videoWidth;
      snapshot.height = video.videoHeight;
      const context = snapshot.getContext("2d");
      if (context) {
        context.drawImage(video, 0, 0);
        const poster = snapshot.toDataURL("image/png");
        // Empty canvas serialization returns data:, rather than an image.
        if (poster && poster !== "data:,") video.poster = poster;
      }
    } catch {
      // Canvas capture is best effort; peer teardown still proceeds.
    }
  }
  return !!video.poster;
}
