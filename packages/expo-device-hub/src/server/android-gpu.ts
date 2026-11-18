/**
 * `GET /api/devices/gpu?serial=<adb serial>`: what a running Android device or
 * emulator renders with, and whether an emulator on this host could render on
 * the GPU. The dashboard shows the renderer in Stream options, and warns on
 * the status pill when an emulator renders on the CPU although it could use
 * the GPU.
 */

import {
  detectBareMetalAppleSilicon,
  type AndroidRenderer,
  readAndroidRenderer,
} from "@expo/hub-android-utils";

import { isSessionDevice, type SingleDevice, singleDeviceRefusal } from "./single-device";

export const ANDROID_GPU_ROUTE = "/api/devices/gpu";

export interface AndroidGpuResponse {
  /**
   * Whether an emulator on this host can render on the GPU with `-gpu host`:
   * an Apple silicon Mac that is not a virtual machine.
   */
  gpuAvailable: boolean;
  /** What the device renders with; `null` when the read failed or timed out. */
  renderer: AndroidRenderer | null;
}

export interface AndroidGpuDependencies {
  /** The serials of the running Android devices that the Hub lists. */
  listSerials: () => Promise<readonly string[]>;
  /** The session's only device, if this Hub serves one device. */
  singleDevice?: SingleDevice;
  detectGpu?: () => Promise<boolean>;
  readRenderer?: typeof readAndroidRenderer;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleAndroidGpuRequest(
  request: Request,
  {
    listSerials,
    singleDevice,
    detectGpu = detectBareMetalAppleSilicon,
    readRenderer = readAndroidRenderer,
  }: AndroidGpuDependencies,
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
  const serial = new URL(request.url).searchParams.get("serial");
  if (!serial) return json({ error: "Expected ?serial=<adb serial>" }, 400);
  if (!isSessionDevice(singleDevice, "android", serial)) return singleDeviceRefusal();
  // adb takes the serial as one argument, but only a device the Hub lists may be read.
  if (!(await listSerials()).includes(serial)) {
    return json({ error: "Not a running Android device of this Hub" }, 404);
  }

  // @ref LLP 0024#warning — the emulator's output cannot tell; read what the guest renders with
  const [gpuAvailable, read] = await Promise.all([
    detectGpu(),
    readRenderer(serial, { signal: request.signal }),
  ]);
  return json({ gpuAvailable, renderer: read.value } satisfies AndroidGpuResponse);
}
