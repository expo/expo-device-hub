import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { tmpdir } from "os";
import { join } from "path";
import {
  type AppIconDeps,
  appContainerFromResult,
  appIconCandidates,
  handleAppIconRequest,
  readAppIcon,
} from "../app-icon";

const UDID = "11111111-2222-3333-4444-555555555555";
const APP_PATH = "/sim/Containers/Bundle/Application/X/Foo.app";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const INFO_PLIST = {
  CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconFiles: ["AppIcon20x20", "AppIcon60x60"] } },
};

function fakeDeps(overrides: Partial<AppIconDeps> & { files?: Record<string, Buffer> } = {}) {
  const reads: string[] = [];
  const files = overrides.files ?? { "AppIcon60x60@2x.png": PNG };
  const deps: AppIconDeps = {
    appContainer: async () => APP_PATH,
    readInfoPlist: async () => INFO_PLIST,
    readIconFile: async (_appPath, name) => {
      reads.push(name);
      return files[name] ?? null;
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
const device = async () => UDID;
const ICON_URL = "/api/apps/icon?bundleId=com.example.foo";

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

describe("appContainerFromResult", () => {
  test("reads the app path from simctl's output", () => {
    expect(appContainerFromResult({ stdout: `${APP_PATH}\n`, stderr: "", exitCode: 0 })).toBe(APP_PATH);
  });

  test("treats simctl's no-such-file error as not installed", () => {
    // What `simctl get_app_container <udid> <unknown bundle> app` prints on Xcode 27.1.
    const stderr =
      "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2):\n" +
      "The operation couldn’t be completed. No such file or directory\nNo such file or directory\n";
    expect(appContainerFromResult({ stdout: "", stderr, exitCode: 2 })).toBeNull();
  });

  test("throws on a timeout or any other failure, so it is not reported as not installed", () => {
    expect(() => appContainerFromResult({ stdout: "", stderr: "did not finish", exitCode: 1, timedOut: true }))
      .toThrow("did not finish");
    expect(() => appContainerFromResult({ stdout: "", stderr: "Invalid device: X", exitCode: 148 }))
      .toThrow("Invalid device");
    expect(() => appContainerFromResult({ stdout: "\n", stderr: "", exitCode: 0 })).toThrow();
  });
});

describe("readAppIcon", () => {
  test("returns the first loose PNG that exists, base64-encoded", async () => {
    const { deps, reads } = fakeDeps();
    expect(await readAppIcon(UDID, "com.example.foo", deps)).toEqual({
      mimeType: "image/png",
      data: PNG.toString("base64"),
    });
    expect(reads).toEqual(["AppIcon60x60@3x.png", "AppIcon60x60@2x.png"]);
  });

  test("returns null when the icon is only in Assets.car", async () => {
    const { deps } = fakeDeps({ files: {} });
    expect(await readAppIcon(UDID, "com.example.foo", deps)).toBeNull();
  });

  test("skips a file that is not a PNG", async () => {
    const { deps } = fakeDeps({ files: { "AppIcon60x60@3x.png": Buffer.from("not a png") } });
    expect(await readAppIcon(UDID, "com.example.foo", deps)).toBeNull();
  });

  test("returns undefined when the app is not installed", async () => {
    const { deps } = fakeDeps({ appContainer: async () => null });
    expect(await readAppIcon(UDID, "com.example.foo", deps)).toBeUndefined();
  });
});

describe("reading the icon file from disk", () => {
  const root = mkdtempSync(join(tmpdir(), "serve-sim-app-icon-"));
  const appPath = join(root, "Foo.app");
  mkdirSync(appPath);
  writeFileSync(join(root, "outside.png"), PNG);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const onDisk = { appContainer: async () => appPath, readInfoPlist: async () => INFO_PLIST };

  test("reads a PNG inside the bundle", async () => {
    writeFileSync(join(appPath, "AppIcon60x60@2x.png"), PNG);
    expect((await readAppIcon(UDID, "com.example.foo", onDisk))?.data).toBe(PNG.toString("base64"));
    rmSync(join(appPath, "AppIcon60x60@2x.png"));
  });

  test("does not follow an icon symlink out of the bundle", async () => {
    symlinkSync(join(root, "outside.png"), join(appPath, "AppIcon60x60@3x.png"));
    symlinkSync("../outside.png", join(appPath, "AppIcon60x60@2x.png"));
    expect(await readAppIcon(UDID, "com.example.foo", onDisk)).toBeNull();
  });
});

describe("handleAppIconRequest", () => {
  test("answers with the icon contract shared with serve-emu", async () => {
    const out = createFakeRes();
    await handleAppIconRequest(req(), out.res, ICON_URL, device, fakeDeps().deps);
    expect(out.status()).toBe(200);
    expect(out.headers()["Content-Type"]).toBe("application/json");
    expect(out.json()).toEqual({
      ok: true,
      bundleId: "com.example.foo",
      icon: { mimeType: "image/png", data: PNG.toString("base64") },
    });
  });

  test("answers icon null when the app has no loose PNG", async () => {
    const out = createFakeRes();
    await handleAppIconRequest(req(), out.res, ICON_URL, device, fakeDeps({ files: {} }).deps);
    expect(out.status()).toBe(200);
    expect(out.json()).toEqual({ ok: true, bundleId: "com.example.foo", icon: null });
  });

  test("rejects a missing or malformed bundle id before it selects a device", async () => {
    let touched = false;
    const resolveUdid = async () => ((touched = true), UDID);
    for (const query of ["", "?bundleId=", "?bundleId=-rf", "?bundleId=a%2Fb"]) {
      const out = createFakeRes();
      await handleAppIconRequest(req(), out.res, `/api/apps/icon${query}`, resolveUdid, fakeDeps().deps);
      expect(out.status()).toBe(400);
      expect(out.json().ok).toBe(false);
    }
    expect(touched).toBe(false);
  });

  test("answers 404 without a device or when the app is not installed", async () => {
    const noDevice = createFakeRes();
    await handleAppIconRequest(req(), noDevice.res, ICON_URL, async () => null, fakeDeps().deps);
    expect(noDevice.status()).toBe(404);

    const missing = createFakeRes();
    await handleAppIconRequest(req(), missing.res, ICON_URL, device, fakeDeps({ appContainer: async () => null }).deps);
    expect(missing.status()).toBe(404);
    expect(missing.json()).toEqual({ ok: false, error: "App com.example.foo is not installed on the simulator" });
  });

  test("answers 503 when the lookup fails, so a client can retry", async () => {
    const out = createFakeRes();
    const failing = fakeDeps({
      appContainer: async () => {
        throw new Error("The xcrun command did not finish within 120s and was stopped.");
      },
    });
    await handleAppIconRequest(req(), out.res, ICON_URL, device, failing.deps);
    expect(out.status()).toBe(503);
    expect(out.json()).toEqual({ ok: false, error: "The xcrun command did not finish within 120s and was stopped." });
  });

  test("answers 405 to anything but GET", async () => {
    for (const method of ["POST", "HEAD"]) {
      const out = createFakeRes();
      await handleAppIconRequest(req(method), out.res, ICON_URL, device, fakeDeps().deps);
      expect(out.status()).toBe(405);
      expect(out.headers().Allow).toBe("GET");
    }
  });
});
