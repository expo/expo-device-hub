export type CamSource = "placeholder" | "image" | "video" | "webcam";
export interface CamWebcam { id: string; name: string }

export type CameraPillState = "ready" | "active" | "disconnected";

export const CAMERA_POLL_INTERVAL_MS = 3000;

interface CameraStatusResponse {
  alive?: boolean;
  /** The helper can be running with no source publishing frames. */
  connected?: boolean;
  source?: string;
  arg?: string;
  mirror?: string;
}

type CameraStatusRequest = (
  endpoint: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "json">>;

export async function requestCameraStatus(
  endpoint: string,
  request: CameraStatusRequest = fetch,
): Promise<CameraStatusResponse | null> {
  try {
    const response = await request(endpoint, { cache: "no-store" });
    if (!response.ok) return null;
    const value = await response.json() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (!("alive" in value) || typeof value.alive !== "boolean") return null;
    return value as CameraStatusResponse;
  } catch {
    return null;
  }
}

export function cameraStatusConnected(reply: CameraStatusResponse | null): boolean {
  return reply?.alive === true && reply.source !== "none" && (reply.connected ?? true);
}

export const CAMERA_LARGE_VIDEO_BYTES = 200 * 1024 * 1024;
export const CAMERA_LARGE_VIDEO_WARNING =
  "Large video (>200 MB) — may stutter on shared memory";
export const CAMERA_HEIC_ERROR =
  "HEIC decode failed — export as JPEG or PNG and retry";

export function nextCameraPillState(
  current: CameraPillState,
  pollAlive: boolean,
): CameraPillState {
  if (pollAlive) return "active";
  if (current === "active") return "disconnected";
  if (current === "disconnected") return "ready";
  return current;
}

export function parseWebcamListOutput(stdout: string): CamWebcam[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const tab = line.indexOf("\t");
      if (tab <= 0) return [];
      const id = line.slice(0, tab).trim();
      const name = line.slice(tab + 1).trim();
      if (!id || !name) return [];
      return [{ id, name }];
    });
}

const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "mov", "qt", "avi", "mkv", "webm", "mpg", "mpeg", "3gp", "3g2", "ts", "wmv",
]);

export function isVideoFile(file: { type?: string; name?: string }): boolean {
  if (file.type && file.type.startsWith("video/")) return true;
  const name = (file.name ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return VIDEO_EXTENSIONS.has(name.slice(dot + 1));
}

export function isOversizedCameraVideo(file: {
  type?: string;
  name?: string;
  size: number;
}): boolean {
  return isVideoFile(file) && file.size > CAMERA_LARGE_VIDEO_BYTES;
}

export function isHeicLikeFile(input: { type?: string; name?: string }): boolean {
  const type = (input.type ?? "").toLowerCase();
  if (type === "image/heic" || type === "image/heif") return true;
  const name = (input.name ?? "").toLowerCase();
  return name.endsWith(".heic") || name.endsWith(".heif");
}

export function cameraSourceErrorMessage({
  rawMessage,
  lastFileIsHeic,
  source,
}: {
  rawMessage: string;
  lastFileIsHeic: boolean;
  source: CamSource;
}): string {
  if (lastFileIsHeic && (source === "image" || source === "video")) {
    return CAMERA_HEIC_ERROR;
  }
  return rawMessage;
}
