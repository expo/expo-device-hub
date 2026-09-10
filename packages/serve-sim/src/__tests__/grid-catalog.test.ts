import { describe, expect, test } from "bun:test";
import {
  gridCatalogNeedsRefresh,
  mergeGridCatalog,
  type GridCatalogDevice,
  type GridDeviceStatus,
} from "../client/utils/grid";

const catalog: GridCatalogDevice[] = [
  { device: "A", name: "iPhone A", runtime: "iOS-26-0", chrome: null },
  { device: "B", name: "iPhone B", runtime: "iOS-26-0", chrome: null },
];

describe("grid catalog and live status split", () => {
  test("overlays status without dropping cached catalog descriptors", () => {
    const statuses: GridDeviceStatus[] = [
      {
        device: "B",
        state: "Booted",
        helper: {
          port: 3200,
          url: "http://localhost:3200/helper/B",
          streamUrl: "http://localhost:3200/helper/B/stream.webrtc",
          wsUrl: "ws://localhost:3200/helper/B/ws",
        },
      },
      { device: "A", state: "Shutdown", helper: null },
    ];

    expect(mergeGridCatalog(catalog, statuses)).toEqual([
      { ...catalog[1]!, ...statuses[0]! },
      { ...catalog[0]!, ...statuses[1]! },
    ]);
  });

  test("keeps a catalog entry visible while its first status sample is pending", () => {
    expect(mergeGridCatalog(catalog, [])).toEqual([
      { ...catalog[0]!, state: "Shutdown", helper: null },
      { ...catalog[1]!, state: "Shutdown", helper: null },
    ]);
  });

  test("requests a catalog page only when a newly relevant device is missing", () => {
    const loaded = [catalog[0]!];
    expect(gridCatalogNeedsRefresh(loaded, [
      { device: "A", state: "Booted", helper: null },
      { device: "B", state: "Shutdown", helper: null },
    ], 1)).toBe(false);
    expect(gridCatalogNeedsRefresh(loaded, [
      { device: "B", state: "Booted", helper: null },
      { device: "A", state: "Shutdown", helper: null },
    ], 1)).toBe(true);
  });
});
