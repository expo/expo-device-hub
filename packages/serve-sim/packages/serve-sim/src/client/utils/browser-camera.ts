import { onCameraStopped, onExecDisconnect, sendCameraFrame, stopCameraFrames } from "./exec";
import { framePolicyBlocks, requestFramePermission } from "./frame-permission";

const CAMERA_WIDTH = 960;
const CAMERA_HEIGHT = 540;
const CAMERA_FPS = 15;
const CAMERA_QUALITY = 0.6;

export const BROWSER_CAMERA_UNSUPPORTED =
  "This browser has no camera API. Open the preview over HTTPS or localhost, then pick Browser camera again.";
export const BROWSER_CAMERA_FRAME_BLOCKED =
  "The page showing this preview blocks the camera. Allow the camera when that page asks, then pick Browser camera again.";

export interface BrowserCameraSession {
  label: string;
  start(): void;
  stop(): void;
}

export interface HeldBrowserCamera {
  udid: string;
  session: BrowserCameraSession;
  abort: AbortController;
}

// Closing the tools panel unmounts the tool, so a running feed is held here for the page.
let heldCamera: HeldBrowserCamera | null = null;
let failedCamera: { udid: string; message: string } | null = null;
const failureListeners = new Set<(udid: string, abort: AbortController, message: string) => void>();

function clearHeld(stop: boolean): void {
  if (!heldCamera) return;
  const { session } = heldCamera;
  heldCamera = null;
  window.removeEventListener("pagehide", stopHeldBrowserCamera);
  if (stop) session.stop();
}

function stopHeldBrowserCamera(): void {
  clearHeld(true);
}

export function takeBrowserCameraFailure(udid: string): string | null {
  if (failedCamera?.udid !== udid) return null;
  const { message } = failedCamera;
  failedCamera = null;
  return message;
}

export function heldBrowserCamera(udid: string): HeldBrowserCamera | null {
  return heldCamera && heldCamera.udid === udid ? heldCamera : null;
}

export function holdBrowserCamera(value: HeldBrowserCamera): void {
  if (heldCamera && heldCamera.session !== value.session) clearHeld(true);
  window.addEventListener("pagehide", stopHeldBrowserCamera);
  heldCamera = value;
}

export function releaseBrowserCamera(udid: string): void {
  if (heldCamera && heldCamera.udid === udid) clearHeld(false);
}

export function stopBrowserCameraExcept(udid: string | null): void {
  if (heldCamera && heldCamera.udid !== udid) clearHeld(true);
}

// A feed can fail while its tool is unmounted, so failures route through here.
export function reportBrowserCameraFailure(
  udid: string,
  abort: AbortController,
  message: string,
): void {
  if (heldCamera && heldCamera.abort === abort) {
    // With no tool mounted to show it, keep the reason for the next one.
    if (failureListeners.size === 0) failedCamera = { udid, message };
    clearHeld(false);
  }
  for (const listener of Array.from(failureListeners)) listener(udid, abort, message);
}

export function onBrowserCameraFailure(
  listener: (udid: string, abort: AbortController, message: string) => void,
): () => void {
  failureListeners.add(listener);
  return () => {
    failureListeners.delete(listener);
  };
}

export function browserCameraSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

export function browserCameraErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access was refused. Allow the camera in this page's site settings, then pick Browser camera again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera found on this device. Connect a camera or choose an image or video.";
  }
  if (name === "NotReadableError") {
    return "The camera is busy. Close other apps using it, then pick Browser camera again.";
  }
  return error instanceof Error && error.message ? error.message : "Could not open the camera. Pick Browser camera to retry.";
}

export async function startBrowserCamera({
  udid,
  signal,
  onError,
}: {
  udid: string;
  signal: AbortSignal;
  onError: (message: string) => void;
}): Promise<BrowserCameraSession> {
  signal.throwIfAborted();
  if (!browserCameraSupported()) throw new Error(BROWSER_CAMERA_UNSUPPORTED);
  // The frame policy rejects getUserMedia at once, and site settings cannot lift it.
  if (framePolicyBlocks("camera")) {
    requestFramePermission("camera");
    throw new Error(BROWSER_CAMERA_FRAME_BLOCKED);
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: CAMERA_WIDTH },
      height: { ideal: CAMERA_HEIGHT },
      frameRate: { ideal: CAMERA_FPS },
    },
    audio: false,
  });
  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let video: HTMLVideoElement | undefined;
  let unsubscribe: (() => void) | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (started) stopCameraFrames(udid);
    clearTimeout(timer);
    unsubscribe?.();
    signal.removeEventListener("abort", stop);
    for (const track of stream.getTracks()) {
      track.removeEventListener("ended", ended);
      track.stop();
    }
    if (video) video.srcObject = null;
  };
  const fail = (message: string) => {
    if (stopped) return;
    stop();
    onError(message);
  };
  const ended = () => fail("The camera stopped. Pick Browser camera again to reconnect.");
  signal.addEventListener("abort", stop, { once: true });

  try {
    if (signal.aborted) {
      stop();
      signal.throwIfAborted();
    }
    for (const track of stream.getTracks()) track.addEventListener("ended", ended);
    video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not encode camera frames. Try another browser.");
    await video.play();
    signal.throwIfAborted();
    if (stopped) throw new Error("The camera stopped before it could start. Pick Browser camera to retry.");

    const tick = async () => {
      if (stopped || !video) return;
      const startTime = Date.now();
      try {
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
          const scale = Math.min(1, CAMERA_WIDTH / video.videoWidth, CAMERA_HEIGHT / video.videoHeight);
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", CAMERA_QUALITY));
          if (stopped) return;
          if (!blob) throw new Error("Could not encode a camera frame. Pick Browser camera to retry.");
          const frame = new Uint8Array(await blob.arrayBuffer());
          if (stopped) return;
          if (sendCameraFrame(udid, frame) === "disconnected") {
            fail("The preview connection closed. Reconnect, then pick Browser camera again.");
            return;
          }
        }
      } catch (error) {
        fail(browserCameraErrorMessage(error));
        return;
      }
      if (!stopped) timer = setTimeout(() => void tick(), Math.max(0, 1000 / CAMERA_FPS - (Date.now() - startTime)));
    };
    return {
      label: stream.getVideoTracks()[0]?.label || "Browser camera",
      start() {
        if (stopped || started) return;
        started = true;
        const offDisconnect = onExecDisconnect(() => fail("The preview connection closed. Reconnect, then pick Browser camera again."));
        const offStopped = onCameraStopped(udid, () => fail("The camera source changed in another session. Pick Browser camera to reconnect this tab."));
        unsubscribe = () => { offDisconnect(); offStopped(); };
        void tick();
      },
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
