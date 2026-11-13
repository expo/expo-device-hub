/**
 * `GET /api/devices/gpu?serial=emulator-<port>`: whether a running emulator
 * renders on the CPU although this host could render it on the GPU. The
 * dashboard shows a warning in Device options from this answer.
 */

import {
  detectBareMetalAppleSilicon,
  type EmulatorRenderer,
  readEmulatorRenderer,
} from "@expo/hub-android-utils";

import { isSessionDevice, type SingleDevice, singleDeviceRefusal } from "./single-device";

export const EMULATOR_GPU_ROUTE = "/api/devices/gpu";

const EMULATOR_SERIAL = /^emulator-\d+$/;

export interface EmulatorGpuResponse {
  /** Whether an emulator on this host can render on the GPU with `-gpu host`. */
  gpuAvailable: boolean;
  /**
   * What the emulator renders with. Read only when `gpuAvailable` is true, so
   * other hosts never run adb for it; `null` when not read or unknown.
   */
  renderer: EmulatorRenderer | null;
}

export interface EmulatorGpuDependencies {
  /** The session's only device, if this Hub serves one device. */
  singleDevice?: SingleDevice;
  detectGpu?: () => Promise<boolean>;
  readRenderer?: typeof readEmulatorRenderer;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleEmulatorGpuRequest(
  request: Request,
  {
    singleDevice,
    detectGpu = detectBareMetalAppleSilicon,
    readRenderer = readEmulatorRenderer,
  }: EmulatorGpuDependencies = {},
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
  const serial = new URL(request.url).searchParams.get("serial");
  if (!serial || !EMULATOR_SERIAL.test(serial)) {
    return json({ error: "Expected ?serial=emulator-<port>" }, 400);
  }
  if (!isSessionDevice(singleDevice, "android", serial)) return singleDeviceRefusal();

  // @ref LLP 0024#warning — the emulator's output cannot tell; read what the guest renders with
  const gpuAvailable = await detectGpu();
  const renderer = gpuAvailable
    ? (await readRenderer(serial, { signal: request.signal })).value
    : null;
  return json({ gpuAvailable, renderer } satisfies EmulatorGpuResponse);
}
