// @ref LLP 0013#single-device-sessions — session target and layout contract
import { type PlatformFilter, parsePlatformFilter } from "../platform-filter";
import type { HubDevice, HubDeviceList } from "./devices";

export type SingleDevice = { platform: PlatformFilter; id: string };

export function parseSingleDevice(
  id: string | undefined,
  platform: PlatformFilter | undefined,
): SingleDevice | undefined {
  if (id === undefined) return undefined;
  if (platform !== "ios" && platform !== "android")
    throw new Error("--single-device requires --platform ios or android.");
  if (platform === "ios") {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("--single-device requires a simulator UDID for iOS.");
    }
    return { platform, id: id.toUpperCase() };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) || ["all", "booted"].includes(id)) {
    throw new Error("--single-device requires an adb serial for Android.");
  }
  return { platform, id };
}

export function readSingleDevice(
  env: Record<string, string | undefined>,
): SingleDevice | undefined {
  if (env.EXPO_DEVICE_HUB_BASE_PATH !== "") return undefined;
  return parseSingleDevice(
    env.EXPO_DEVICE_HUB_SINGLE_DEVICE,
    parsePlatformFilter(env.EXPO_DEVICE_HUB_PLATFORM),
  );
}

export const SERVER_SINGLE_DEVICE = readSingleDevice(process.env);

export function isSessionDevice(
  policy: SingleDevice | undefined,
  platform: string,
  id: string,
): boolean {
  if (policy === undefined) return true;
  return platform === policy.platform && (platform === "ios" ? id.toUpperCase() : id) === policy.id;
}

export function allowsSessionDeviceAction(
  policy: SingleDevice | undefined,
  action: "boot" | "shutdown" | "remove",
  device: Pick<HubDevice, "platform" | "id">,
): boolean {
  if (!policy) return true;
  if (!isSessionDevice(policy, device.platform, device.id)) return false;
  return action === "shutdown" || (action === "boot" && device.platform === "ios");
}

export function filterSessionDevices(
  list: HubDeviceList,
  policy = SERVER_SINGLE_DEVICE,
): HubDeviceList {
  if (!policy) return list;
  return {
    ...list,
    simulators: list.simulators.filter((d) => isSessionDevice(policy, d.platform, d.id)),
    emulators: list.emulators.filter((d) => isSessionDevice(policy, d.platform, d.id)),
  };
}

/** Android's fleet actions accept targets in JSON, independently of ?device=. */
export function scopeEmuRequest(request: Request, policy = SERVER_SINGLE_DEVICE): Request | null {
  if (!policy) return request;
  if (policy.platform !== "android") return null;
  const url = new URL(request.url);
  if (url.searchParams.getAll("device").some((id) => id !== policy.id)) return null;
  if (/\/api\/(?:devices|device-grid|avds)(?:\/|$)/.test(url.pathname)) return null;
  url.searchParams.set("device", policy.id);
  return new Request(url, request);
}

export function singleDeviceRefusal(): Response {
  return Response.json(
    { ok: false, error: "This action is unavailable in this single-device session." },
    { status: 403 },
  );
}

/** A peer can emit a protocol error while the refusal's close frame is in flight. */
export function refuseSingleDeviceSocket(socket: {
  on(event: "error", listener: () => void): unknown;
  close(): void;
}): void {
  socket.on("error", () => {});
  socket.close();
}
