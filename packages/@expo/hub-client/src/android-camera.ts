import { type DeviceCameraFacing, type DeviceCameraFeed, type DeviceCameraStatus } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseFeed(
  payload: unknown,
  imageUrl: (facing: DeviceCameraFacing, digest: string | null) => string,
): DeviceCameraFeed | null {
  const data = asRecord(payload);
  if (!data) return null;
  const facing = data.facing;
  if (facing !== "back" && facing !== "front") return null;
  const placeholder = data.placeholder;
  const present = data.present;
  if (typeof placeholder !== "boolean" || typeof present !== "boolean") return null;
  const digest = typeof data.digest === "string" ? data.digest : null;
  return {
    facing,
    placeholder,
    width: finiteNumber(data.width),
    height: finiteNumber(data.height),
    bytes: finiteNumber(data.bytes),
    imageUrl: present ? imageUrl(facing, digest) : null,
  };
}

/** One accepted `/api/camera` payload. */
export interface AndroidCameraRead {
  supported: boolean;
  status: DeviceCameraStatus;
}

export function parseAndroidCameraStatus(
  payload: unknown,
  imageUrl: (facing: DeviceCameraFacing, digest: string | null) => string,
): AndroidCameraRead | null {
  const data = asRecord(payload);
  if (!data || data.ok !== true) return null;
  const camera = asRecord(data.camera);
  if (!camera) return null;
  const supported = camera.supported;
  const wiredAtLaunch = camera.wiredAtLaunch;
  if (typeof supported !== "boolean" || typeof wiredAtLaunch !== "boolean") return null;
  if (!Array.isArray(camera.feeds)) return null;

  const feeds = camera.feeds
    .map((feed) => parseFeed(feed, imageUrl))
    .filter((feed): feed is DeviceCameraFeed => feed !== null);

  return { supported, status: { wiredAtLaunch, feeds } };
}

export function androidCameraImagePath(facing: DeviceCameraFacing, digest: string | null): string {
  const path = `/api/camera/image?facing=${facing}`;
  return digest === null ? path : `${path}&v=${encodeURIComponent(digest)}`;
}

export function androidCameraErrorMessage(status: number, payload: unknown): string {
  const data = asRecord(payload);
  if (data && typeof data.error === "string") return data.error;
  return `Camera update failed (${status})`;
}

/** A status read that overlaps a write is stale for that facing, so the written feed stays. */
export function keepPendingCameraFeeds(
  current: DeviceCameraStatus | null,
  next: DeviceCameraStatus,
  pendingFacings: ReadonlySet<DeviceCameraFacing>,
): DeviceCameraStatus {
  if (pendingFacings.size === 0 || !current) return next;
  return {
    ...next,
    feeds: next.feeds.map((feed) =>
      pendingFacings.has(feed.facing)
        ? (current.feeds.find((held) => held.facing === feed.facing) ?? feed)
        : feed,
    ),
  };
}

/** Camera state held by the viewer between reads. */
export interface AndroidCameraState {
  status: DeviceCameraStatus | null;
  supported: boolean;
}

export const NO_ANDROID_CAMERA: AndroidCameraState = { status: null, supported: false };

/**
 * Fold one `/api/camera` read into the held state.
 *
 * A failed or unreadable read keeps the last good state, so a transient error
 * does not hide the camera controls. Only an accepted payload turns support off.
 */
export function applyCameraRead(
  state: AndroidCameraState,
  read: AndroidCameraRead | null,
  pendingFacings: ReadonlySet<DeviceCameraFacing>,
): AndroidCameraState {
  if (!read) return state;
  return {
    status: keepPendingCameraFeeds(state.status, read.status, pendingFacings),
    supported: read.supported,
  };
}
