import { type CameraFacing, type DeviceCamera, type DeviceCameraFeed } from './types';

export const CAMERA_FACINGS: readonly CameraFacing[] = ['back', 'front'];

/** Hub URL for one feed's PNG. `digest` versions it so an <img> refetches when the file changes. */
export function androidCameraImageUrl(
  baseUrl: string,
  device: string | null,
  facing: CameraFacing,
  digest: string | null,
): string {
  // Join as a string so a Hub mount prefix (`…/_expo/plugins/serve-emu`) survives;
  // `new URL('/api/…', baseUrl)` would drop it. Same reasoning as `apiUrl` in
  // `useAndroidDevice.ts`.
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/api/camera/image`);
  url.searchParams.set('facing', facing);
  if (device) url.searchParams.set('device', device);
  if (digest !== null) url.searchParams.set('v', digest);
  return url.toString();
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isCameraFacing(value: unknown): value is CameraFacing {
  return CAMERA_FACINGS.some((facing) => facing === value);
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseFeed(
  value: unknown,
  imageUrlFor: (facing: CameraFacing, digest: string | null) => string,
): DeviceCameraFeed | null {
  const entry = plainObject(value);
  if (!entry) return null;
  const { facing, present, placeholder, width, height, bytes, digest, updatedAt } = entry;
  if (!isCameraFacing(facing)) return null;
  if (typeof present !== 'boolean' || typeof placeholder !== 'boolean') return null;
  if (!isFiniteOrNull(width) || !isFiniteOrNull(height) || !isFiniteOrNull(bytes)) return null;
  if (!isStringOrNull(digest) || !isStringOrNull(updatedAt)) return null;
  return {
    facing,
    present,
    placeholder,
    width,
    height,
    bytes,
    updatedAt,
    imageUrl: present ? imageUrlFor(facing, digest) : null,
  };
}

/** Null on any shape violation and when the backend reports the camera unsupported. */
export function parseAndroidCamera(
  payload: unknown,
  imageUrlFor: (facing: CameraFacing, digest: string | null) => string,
): DeviceCamera | null {
  const root = plainObject(payload);
  if (!root || root.ok !== true) return null;
  const camera = plainObject(root.camera);
  if (!camera || camera.supported !== true) return null;
  const { wiredAtLaunch, launchArgs, feeds } = camera;
  if (typeof wiredAtLaunch !== 'boolean' || !isStringArray(launchArgs)) return null;
  if (!Array.isArray(feeds)) return null;

  const parsed: DeviceCameraFeed[] = [];
  for (const entry of feeds as unknown[]) {
    const feed = parseFeed(entry, imageUrlFor);
    if (!feed) return null;
    parsed.push(feed);
  }
  parsed.sort((a, b) => CAMERA_FACINGS.indexOf(a.facing) - CAMERA_FACINGS.indexOf(b.facing));
  return { wiredAtLaunch, launchArgs, feeds: parsed };
}

/** The `error` string from a `{ ok: false, error }` write response; null when absent. */
export function androidCameraErrorMessage(payload: unknown): string | null {
  const root = plainObject(payload);
  const detail = typeof root?.error === 'string' ? root.error.trim() : '';
  return detail || null;
}
