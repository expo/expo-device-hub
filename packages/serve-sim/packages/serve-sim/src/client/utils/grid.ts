export interface GridDevice {
  device: string;
  name: string;
  runtime: string;
  state: string;
  chrome?: DeviceKitChromeDescriptor | null;
  placeholderAsset?: DevicePlaceholderAssetDescriptor | null;
  helper: { port: number; url: string; streamUrl: string; wsUrl: string } | null;
}

export type GridCatalogDevice = Omit<GridDevice, "state" | "helper">;

export type GridDeviceStatus = Pick<GridDevice, "device" | "state" | "helper">;

export interface GridCatalogResponse {
  devices: GridCatalogDevice[];
  total: number;
  offset: number;
  limit: number;
}

export interface GridStatusResponse {
  statuses: GridDeviceStatus[];
}

/**
 * Overlay the small live status feed on the cached catalog. Status order is
 * authoritative, so streaming/booted devices continue to float to the top
 * without re-downloading their static DeviceKit descriptors.
 */
export function mergeGridCatalog(
  catalog: readonly GridCatalogDevice[],
  statuses: readonly GridDeviceStatus[],
): GridDevice[] {
  const catalogByUdid = new Map(catalog.map((device) => [device.device, device] as const));
  const merged: GridDevice[] = [];

  for (const status of statuses) {
    const device = catalogByUdid.get(status.device);
    if (!device) continue;
    merged.push({ ...device, state: status.state, helper: status.helper });
    catalogByUdid.delete(status.device);
  }

  // A newly added runtime may appear in the catalog just before the next
  // status sample. Keep it visible with a conservative stopped state.
  for (const device of catalogByUdid.values()) {
    merged.push({ ...device, state: "Shutdown", helper: null });
  }
  return merged;
}

/** Whether a status reorder moved an uncached device into the loaded window. */
export function gridCatalogNeedsRefresh(
  catalog: readonly GridCatalogDevice[],
  statuses: readonly GridDeviceStatus[],
  limit: number,
): boolean {
  if (catalog.length === 0) return false;
  const loaded = new Set(catalog.map((device) => device.device));
  return statuses.slice(0, Math.min(limit, statuses.length)).some((status) => !loaded.has(status.device));
}

export interface DevicePlaceholderAssetDescriptor {
  name: string;
  width: number;
  height: number;
}

export interface DeviceKitChromeDescriptor {
  identifier: string;
  frame: GridSize;
  body: GridRect;
  screen: GridRect;
  insets: GridInsets;
  outerCornerRadius: number;
  innerCornerRadius: number;
  screenRadius: number;
  compositeImage: string | null;
  slice: DeviceKitChromeSlice | null;
  corner: GridSize | null;
  buttons: DeviceKitChromeButton[];
}

export interface DeviceKitChromeButton {
  name: string;
  image: string;
  imageDown: string | null;
  onTop: boolean;
  frame: GridRect;
  hover: { x: number; y: number };
  usagePage: number | null;
  usage: number | null;
}

export interface DeviceKitChromeSlice {
  topLeft: string;
  top: string;
  topRight: string;
  right: string;
  bottomRight: string;
  bottom: string;
  bottomLeft: string;
  left: string;
}

export interface GridSize {
  width: number;
  height: number;
}

export interface GridRect extends GridSize {
  x: number;
  y: number;
}

export interface GridInsets {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface MemoryReport {
  totalBytes: number;
  availableBytes: number;
  runningSimulators: number;
  perSimAvgBytes: number;
  perSimSource: "measured" | "estimated";
  estimatedAdditional: number;
}

export function formatGridBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

export function gridPreviewHref(previewEndpoint: string, udid: string): string {
  const sep = previewEndpoint.includes("?") ? "&" : "?";
  return `${previewEndpoint}${sep}device=${encodeURIComponent(udid)}`;
}

// Grid runtimes arrive as `iOS-26-5` / `watchOS-11-2` (simctl's SimRuntime
// suffix). Split the OS name from its dotted version for display.
export function parseRuntime(runtime: string): { os: string; version: string } {
  const m = runtime.match(/^([a-zA-Z]+)-(.+)$/);
  if (!m) return { os: runtime, version: "" };
  return { os: m[1]!, version: m[2]!.replace(/-/g, ".") };
}

/** Just the dotted version, e.g. `26.5`. */
export function runtimeVersion(runtime: string): string {
  return parseRuntime(runtime).version || runtime;
}

/** Human label, e.g. `iOS 26.5`. */
export function runtimeLabel(runtime: string): string {
  const { os, version } = parseRuntime(runtime);
  return version ? `${os} ${version}` : os;
}
