import * as fs from "fs";
import { createServer } from "http";
import { describe, expect, spyOn, test } from "bun:test";
import {
  bareChromeIdentifier,
  logicalScreenSizeFromProfile,
  parsePdfPageSize,
  parseDisplayProfiles,
  measureScreenOpening,
  resolveDevicePlaceholderAsset,
  resolveDeviceKitChrome,
  serveDeviceKitChromeAsset,
} from "../devicekit-chrome";

describe("DeviceKit chrome helpers", () => {
  test("reads each display's corner metadata without averaging or mixing displays", () => {
    const display = {
      displayType: "integrated", screenID: 1,
      chromeIdentifier: "com.apple.dt.devicekit.chrome.phone15",
      width: 1398, height: 2034, scale: 3,
      cornerRadiusUL: 8, cornerRadiusUR: 59, cornerRadiusLR: 59, cornerRadiusLL: 8,
      framebufferMaskIdentifier: "closed-mask",
    };
    expect(parseDisplayProfiles([display])).toEqual([{
      screenId: 1, chromeIdentifier: "phone15", screenSize: { width: 466, height: 678 },
      cornerRadii: { topLeft: 8, topRight: 59, bottomRight: 59, bottomLeft: 8 },
      framebufferMask: "closed-mask",
    }]);
    expect(parseDisplayProfiles([
      { ...display, scale: 0 }, { ...display, cornerRadiusUL: undefined },
      { ...display, displayType: "tvOut" },
    ])).toEqual([]);
  });

  test("keeps all four measured corners distinct when profile metadata is absent", () => {
    const width = 40, height = 50;
    const mask = new Uint8Array(width * height);
    for (let y = 5; y < 45; y++) {
      for (let x = 5; x < 35; x++) {
        if ((x - 5) + (y - 5) < 2 || (34 - x) + (y - 5) < 8 ||
            (34 - x) + (44 - y) < 6 || (x - 5) + (44 - y) < 4) continue;
        mask[y * width + x] = 1;
      }
    }
    expect(measureScreenOpening({ width, height, mask })).toEqual({
      x: 5, y: 5, width: 30, height: 40,
      cornerRadii: { topLeft: 2, topRight: 8, bottomRight: 6, bottomLeft: 4 },
    });
  });

  test("resolves both Duo screens and the asymmetric closed screen from installed assets", () => {
    if (!fs.existsSync("/Library/Developer/DeviceKit/Chrome/phone15.devicechrome")) return;
    const chrome = resolveDeviceKitChrome({ name: "iPhone Duo" });
    if (!chrome) return;
    expect(chrome.screenId).toBe(1);
    expect(chrome.screenCornerRadii).toEqual({ topLeft: 8, topRight: 59, bottomRight: 59, bottomLeft: 8 });
    expect(chrome.screen.x - chrome.body.x).toBe(25);
    expect(chrome.screen.y - chrome.body.y).toBe(14);
    const inner = chrome.displayVariants?.[3];
    expect(inner?.identifier).toBe("phone14");
    expect(inner?.screen.width).toBeGreaterThan(chrome.screen.width);
    expect(inner?.screenCornerRadii?.topLeft).toBe(inner?.screenCornerRadii?.bottomRight);
    // phone14's button PDFs carry /Rotate 270; their rendered dimensions
    // must follow the declared left/top anchors rather than the raw MediaBox.
    expect(inner?.buttons.find((button) => button.name === "volume-up")?.frame).toEqual({
      x: 7, y: 124, width: 16, height: 63,
    });
    expect(inner?.buttons.find((button) => button.name === "power")?.frame).toEqual({
      x: 206, y: 6, width: 107, height: 16,
    });
    expect(chrome.buttons.find((button) => button.name === "volume-up")?.frame).toEqual({
      x: 325, y: 5, width: 66, height: 16,
    });
    expect(() => JSON.stringify(chrome)).not.toThrow();
  });

  test("strips Apple's chrome bundle prefix", () => {
    expect(bareChromeIdentifier("com.apple.dt.devicekit.chrome.phone11")).toBe("phone11");
    expect(bareChromeIdentifier("watch2")).toBe("watch2");
  });

  test("serves button rasterizations in the same orientation as their descriptor", async () => {
    if (!fs.existsSync("/Library/Developer/DeviceKit/Chrome/phone15.devicechrome")) return;
    const server = createServer((req, res) => {
      serveDeviceKitChromeAsset(new URL(req.url ?? "/", "http://localhost"), res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      for (const [chrome, image, width, height] of [
        ["phone14", "Vol BTN", 16, 63],
        ["phone14", "X Power BTN", 107, 16],
        ["phone15", "Vol BTN", 66, 16],
      ] as const) {
        const url = new URL(`http://127.0.0.1:${address.port}`);
        url.searchParams.set("chrome", chrome);
        url.searchParams.set("image", image);
        const response = await fetch(url);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        const png = Buffer.from(await response.arrayBuffer());
        expect(png.toString("ascii", 12, 16)).toBe("IHDR");
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height]);
        const reads = spyOn(fs, "readFileSync");
        try {
          const cached = await fetch(url);
          expect(cached.status).toBe(200);
          expect(Buffer.from(await cached.arrayBuffer())).toEqual(png);
          expect(reads.mock.calls.some(([path]) => String(path).endsWith(".pdf"))).toBe(false);
        } finally {
          reads.mockRestore();
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("parses MediaBox page dimensions from a PDF payload", () => {
    expect(parsePdfPageSize("2 0 obj << /Type /Pages /MediaBox [0 0 65 97] >>")).toEqual({
      width: 65,
      height: 97,
    });
  });

  for (const rotation of [90, 270, -90, 450]) {
    test(`honors the PDF page rotation of ${rotation} degrees`, () => {
      expect(parsePdfPageSize(`/MediaBox [0 0 63 16] /Rotate ${rotation}`)).toEqual({
        width: 16, height: 63,
      });
    });
  }

  test("keeps dimensions for a half-turn and uses the latest incremental rotation", () => {
    expect(parsePdfPageSize("/MediaBox [0 0 63 16] /Rotate 180")).toEqual({ width: 63, height: 16 });
    expect(parsePdfPageSize("/MediaBox [0 0 63 16] /Rotate 0\n%%EOF\n/Rotate 270")).toEqual({ width: 16, height: 63 });
    expect(parsePdfPageSize("/MediaBox [0 0 63 16] /Rotate 270\n%%EOF\n/Rotate 0")).toEqual({ width: 63, height: 16 });
  });

  test("prefers explicit main screen plist dimensions when present", () => {
    expect(
      logicalScreenSizeFromProfile(
        {
          mainScreenWidth: 1206,
          mainScreenHeight: 2622,
          mainScreenScale: 3,
        },
        "phone11",
      ),
    ).toEqual({ width: 402, height: 874 });
  });

  test("resolves stock watch chrome from installed DeviceKit assets when available", () => {
    if (!fs.existsSync("/Library/Developer/DeviceKit/Chrome/watch2.devicechrome")) return;

    const chrome = resolveDeviceKitChrome({
      name: "renamed clone",
      deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-SE-3-40mm",
    });

    expect(chrome?.identifier).toBe("watch2");
    expect(chrome?.slice?.topLeft).toBe("WatchTL");
    // The exact screen extent depends on which DeviceKit chrome assets the
    // installed SDK ships (composite image vs. profile metadata yields px vs.
    // pt), so assert it resolves to a sane positive value rather than pinning
    // a single machine's SDK geometry.
    expect(chrome?.screen.width).toBeGreaterThan(0);
    expect(chrome?.buttons.some((button) => button.name === "digital-crown")).toBe(true);
  });

  test("resolves Device Hub-style placeholder assets from CoreTypes metadata", () => {
    if (!fs.existsSync("/System/Library/CoreServices/CoreTypes.bundle/Contents/Library/MobileDevices.bundle")) return;

    // The CoreTypes icon set ships with the host SDK, so older runner images
    // (e.g. GitHub's macos-latest) may not carry every current device's asset.
    // When a device's asset is absent the resolver returns null — skip that
    // case rather than pinning one machine's SDK. When it does resolve, assert
    // the metadata mapping (icon name) and that cropping produced sane bounds.
    const expectPlaceholder = (
      device: { name: string; deviceTypeIdentifier: string },
      expectedName: string | string[],
    ) => {
      const resolved = resolveDevicePlaceholderAsset(device);
      if (!resolved) return;
      expect(Array.isArray(expectedName) ? expectedName : [expectedName]).toContain(resolved.name);
      expect(resolved.width).toBeGreaterThan(0);
      expect(resolved.height).toBeGreaterThan(0);
    };

    expectPlaceholder(
      {
        name: "iPhone 17 Pro",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      },
      "com.apple.iphone-17-pro-2",
    );
    expectPlaceholder(
      {
        name: "Apple Watch Ultra 3 (49mm)",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-3-49mm",
      },
      "com.apple.apple-watch-ultra-3-8",
    );
    expectPlaceholder(
      {
        name: "iPad Air 11-inch (M4)",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4",
      },
      // Newer CoreTypes includes the exact M4 artwork; older SDKs use the fallback.
      ["com.apple.ipad-air-11-inch-m4-1", "ipad-air-11-inch-m4"],
    );
  });
});
