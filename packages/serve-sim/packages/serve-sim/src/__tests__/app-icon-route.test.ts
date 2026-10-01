import { describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "http";
import { type AppIconDeps, appIconCandidates, handleAppIconRequest, readAppIcon } from "../app-icon";

const UDID = "11111111-2222-3333-4444-555555555555";
const APP_PATH = "/sim/Containers/Bundle/Application/X/Foo.app";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const INFO_PLIST = {
  CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconFiles: ["AppIcon20x20", "AppIcon60x60"] } },
};

function fakeDeps(overrides: Partial<AppIconDeps> & { files?: Record<string, Buffer> } = {}) {
  const reads: string[] = [];
  const files = overrides.files ?? { [`${APP_PATH}/AppIcon60x60@2x.png`]: PNG };
  const deps: AppIconDeps = {
    appContainer: async () => APP_PATH,
    readInfoPlist: async () => INFO_PLIST,
    readIconFile: async (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
    ...overrides,
  };
  return { deps, reads };
}

function createFakeRes() {
  let statusCode = 0;
  let headers: Record<string, string> = {};
  let body = "";
  const res = {
    writeHead(status: number, h?: Record<string, string>) {
      statusCode = status;
      headers = h ?? {};
      return res;
    },
    end(chunk?: string) {
      if (chunk !== undefined) body += chunk;
      return res;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => statusCode,
    headers: () => headers,
    json: () => JSON.parse(body) as Record<string, unknown>,
  };
}

const req = (method = "GET") => ({ method, headers: {} }) as unknown as IncomingMessage;

describe("appIconCandidates", () => {
  test("tries the largest plist icon first, with the same names as the preview client", () => {
    expect(appIconCandidates(INFO_PLIST)).toEqual([
      "AppIcon60x60@3x.png",
      "AppIcon60x60@2x.png",
      "AppIcon60x60.png",
      "AppIcon60x6060x60@3x.png",
      "AppIcon60x6060x60@2x.png",
    ]);
  });

  test("falls back to the iPad and legacy keys", () => {
    expect(appIconCandidates({ "CFBundleIcons~ipad": { CFBundlePrimaryIcon: { CFBundleIconFiles: ["Pad"] } } })[0])
      .toBe("Pad@3x.png");
    expect(appIconCandidates({ CFBundleIconFiles: ["Old"] })[0]).toBe("Old@3x.png");
    expect(appIconCandidates({ CFBundleIconFile: "Legacy" })[0]).toBe("Legacy@3x.png");
  });

  test("refuses an icon name that would leave the app bundle", () => {
    expect(appIconCandidates({ CFBundleIconFile: "../../secret" })).toEqual([]);
    expect(appIconCandidates({ CFBundleIconFile: ".hidden" })).toEqual([]);
    expect(appIconCandidates({})).toEqual([]);
  });
});

describe("readAppIcon", () => {
  test("returns the first loose PNG that exists, base64-encoded", async () => {
    const { deps, reads } = fakeDeps();
    expect(await readAppIcon(UDID, "com.example.foo", deps)).toEqual({
      mimeType: "image/png",
      data: PNG.toString("base64"),
    });
    expect(reads).toEqual([`${APP_PATH}/AppIcon60x60@3x.png`, `${APP_PATH}/AppIcon60x60@2x.png`]);
  });

  test("returns null when the icon is only in Assets.car", async () => {
    const { deps } = fakeDeps({ files: {} });
    expect(await readAppIcon(UDID, "com.example.foo", deps)).toBeNull();
  });

  test("skips a file that is not a PNG", async () => {
    const { deps } = fakeDeps({ files: { [`${APP_PATH}/AppIcon60x60@3x.png`]: Buffer.from("not a png") } });
    expect(await readAppIcon(UDID, "com.example.foo", deps)).toBeNull();
  });

  test("returns undefined when the app is not installed", async () => {
    const { deps } = fakeDeps({ appContainer: async () => null });
    expect(await readAppIcon(UDID, "com.example.foo", deps)).toBeUndefined();
  });
});

describe("handleAppIconRequest", () => {
  test("answers with the serve-emu icon contract", async () => {
    const { deps } = fakeDeps();
    const out = createFakeRes();
    await handleAppIconRequest(req(), out.res, UDID, "/api/apps/icon?bundleId=com.example.foo", deps);
    expect(out.status()).toBe(200);
    expect(out.headers()["Content-Type"]).toBe("application/json");
    expect(out.json()).toEqual({
      ok: true,
      bundleId: "com.example.foo",
      icon: { mimeType: "image/png", data: PNG.toString("base64") },
    });
  });

  test("answers icon null when the app has no loose PNG", async () => {
    const { deps } = fakeDeps({ files: {} });
    const out = createFakeRes();
    await handleAppIconRequest(req(), out.res, UDID, "/api/apps/icon?bundleId=com.example.foo", deps);
    expect(out.status()).toBe(200);
    expect(out.json()).toEqual({ ok: true, bundleId: "com.example.foo", icon: null });
  });

  test("rejects a missing or malformed bundle id before touching the host", async () => {
    let touched = false;
    const { deps } = fakeDeps({ appContainer: async () => ((touched = true), APP_PATH) });
    for (const query of ["", "?bundleId=", "?bundleId=-rf", "?bundleId=a%2Fb"]) {
      const out = createFakeRes();
      await handleAppIconRequest(req(), out.res, UDID, `/api/apps/icon${query}`, deps);
      expect(out.status()).toBe(400);
      expect(out.json().ok).toBe(false);
    }
    expect(touched).toBe(false);
  });

  test("answers 404 without a device or when the app is not installed", async () => {
    const noDevice = createFakeRes();
    await handleAppIconRequest(req(), noDevice.res, null, "/api/apps/icon?bundleId=com.example.foo", fakeDeps().deps);
    expect(noDevice.status()).toBe(404);

    const missing = createFakeRes();
    const { deps } = fakeDeps({ appContainer: async () => null });
    await handleAppIconRequest(req(), missing.res, UDID, "/api/apps/icon?bundleId=com.example.foo", deps);
    expect(missing.status()).toBe(404);
    expect(missing.json()).toEqual({ ok: false, error: "App com.example.foo is not installed on the simulator" });
  });

  test("answers 405 to a write-shaped request", async () => {
    const out = createFakeRes();
    await handleAppIconRequest(req("POST"), out.res, UDID, "/api/apps/icon?bundleId=com.example.foo", fakeDeps().deps);
    expect(out.status()).toBe(405);
  });
});
