/**
 * Which serve-sim features a device has. A physical iPhone or iPad streams its screen, takes
 * touch, keyboard and Home, and takes screenshots and recordings. Every feature below needs a
 * simulator, through simctl, CoreSimulator, or a dylib injected into the simulator's apps, so a
 * physical device has none of them. This module is the one place that decides that: routes refuse
 * through `deviceFeatureRefusal`, and the preview config reports `unavailableDeviceFeatures` so
 * that clients show each feature as not available.
 *
 * "Capability" means an injected dylib in serve-sim (see capabilities.ts), so this module says
 * "feature".
 */

export type DeviceKind = "simulator" | "physical";

export const DEVICE_FEATURES = {
  clipboard: { subject: "Clipboard", plural: false },
  apps: { subject: "App install, launch, files and icons", plural: true },
  permissions: { subject: "App permissions", plural: true },
  location: { subject: "Location", plural: false },
  logs: { subject: "Device logs and crash reports", plural: true },
  deviceSettings: { subject: "Simulator settings", plural: true },
  appInjection: { subject: "Camera injection and network capture", plural: true },
  devtools: { subject: "Web Inspector", plural: false },
  accessibility: { subject: "The accessibility tree", plural: false },
  foregroundApp: { subject: "The foreground app", plural: false },
  activity: { subject: "Activity metrics", plural: true },
  hinge: { subject: "Hinge controls", plural: true },
  rotate: { subject: "Rotate", plural: false },
  lifecycle: { subject: "Booting and shutting down", plural: true },
} as const satisfies Record<string, { subject: string; plural: boolean }>;

export type DeviceFeature = keyof typeof DEVICE_FEATURES;

const SIMULATOR_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const HARDWARE_UDID = /^(?:[0-9A-F]{8}-[0-9A-F]{16}|[0-9A-F]{40})$/i;

/**
 * A hardware UDID, such as `00008101-0016603236F0801E` or an older 40-digit one, names a physical
 * device. Everything else, a CoreSimulator UUID or a simulator name, names a simulator.
 */
export function deviceKindOf(device: string): DeviceKind {
  return HARDWARE_UDID.test(device) && !SIMULATOR_UDID.test(device) ? "physical" : "simulator";
}

const AVAILABLE: Record<DeviceKind, (feature: DeviceFeature) => boolean> = {
  simulator: () => true,
  physical: () => false,
};

function reason(feature: DeviceFeature, kind: DeviceKind): string {
  const { subject, plural } = DEVICE_FEATURES[feature];
  return `${subject} ${plural ? "are" : "is"} not available on a ${kind} device.`;
}

/** Each feature `device` does not have, with the reason a client shows. Empty for a simulator. */
export function unavailableDeviceFeatures(device: string): Partial<Record<DeviceFeature, string>> {
  const kind = deviceKindOf(device);
  const unavailable: Partial<Record<DeviceFeature, string>> = {};
  for (const feature of Object.keys(DEVICE_FEATURES) as DeviceFeature[]) {
    if (!AVAILABLE[kind](feature)) unavailable[feature] = reason(feature, kind);
  }
  return unavailable;
}

/** Why `device` cannot use `feature`, or null when it can or nothing is asked. */
export function deviceFeatureRefusal(
  device: string | null | undefined,
  feature: DeviceFeature | null,
): string | null {
  if (!device || !feature) return null;
  const kind = deviceKindOf(device);
  return AVAILABLE[kind](feature) ? null : reason(feature, kind);
}

const ROUTE_FEATURES: ReadonlyArray<[match: (path: string) => boolean, feature: DeviceFeature]> = [
  [(path) => path === "/api/pasteboard", "clipboard"],
  [(path) => path === "/api/apps/icon", "apps"],
  [(path) => path === "/logs" || path === "/crashes" || path.startsWith("/crashes/"), "logs"],
  [(path) => path === "/ax", "accessibility"],
  [(path) => path === "/metrics", "activity"],
  [(path) => path === "/appstate", "foregroundApp"],
  [(path) => path.startsWith("/network-capture"), "appInjection"],
  [(path) => path === "/devtools" || path.startsWith("/devtools/"), "devtools"],
  [(path) => path === "/grid/api/shutdown", "lifecycle"],
];

/** The feature a middleware route needs. `path` is relative to the mount and has no query. */
export function routeFeature(path: string): DeviceFeature | null {
  return ROUTE_FEATURES.find(([match]) => match(path))?.[1] ?? null;
}

/** The feature a `/helper/<device>/…` route needs. `path` is the part after the device. */
export function helperRouteFeature(path: string): DeviceFeature | null {
  const endpoint = path.split("?")[0]!;
  if (endpoint === "/ax") return "accessibility";
  if (endpoint === "/foreground") return "foregroundApp";
  if (endpoint === "/camera/status") return "appInjection";
  if (endpoint.startsWith("/panel/")) return "hinge";
  return null;
}
