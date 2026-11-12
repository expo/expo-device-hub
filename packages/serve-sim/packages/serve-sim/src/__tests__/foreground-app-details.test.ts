import { describe, expect, test } from "bun:test";
import { join } from "path";

import { ConfinedPath } from "../host-paths";
import {
  type ForegroundAppDetailsDeps,
  appLabelFromInfoPlist,
  describeForegroundApp,
} from "../foreground-app-details";

const UDID = "11111111-2222-3333-4444-555555555555";

// Where simctl reported Safari on an EAS iOS 27.1 worker: the runtime is mounted by cryptexd, outside
// ConfinedPath's roots, so a client-sent `app.infoPlist` for this path is refused.
const CRYPTEX_SAFARI =
  "/private/var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-v24.1.94232.0.GovRz1" +
  "/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.1.simruntime/Contents/Resources/RuntimeRoot" +
  "/Applications/MobileSafari.app";

// The name keys of real Info.plist files, read with `plutil -convert json` from the iOS 26.5 runtime.
const SAFARI = { CFBundleDisplayName: "Safari", CFBundleExecutable: "MobileSafari" };
const SETTINGS = { CFBundleDisplayName: "Settings", CFBundleName: "Settings" };
const SPRINGBOARD = { CFBundleName: "SpringBoard", CFBundleExecutable: "SpringBoard" };

function fakeDeps(
  appPath: string | null | Error,
  plist: unknown,
  files: string[] = [],
): ForegroundAppDetailsDeps & { plistReads: string[] } {
  const plistReads: string[] = [];
  return {
    plistReads,
    appContainer: async () => {
      if (appPath instanceof Error) throw appPath;
      return appPath;
    },
    readInfoPlist: async (path) => {
      plistReads.push(path);
      return plist;
    },
    exists: (path) => files.some((file) => path === join(appPath as string, file)),
  };
}

describe("appLabelFromInfoPlist", () => {
  test("reads the display name, then the bundle name, from real plists", () => {
    expect(appLabelFromInfoPlist(SAFARI)).toBe("Safari");
    expect(appLabelFromInfoPlist(SETTINGS)).toBe("Settings");
    expect(appLabelFromInfoPlist(SPRINGBOARD)).toBe("SpringBoard");
  });

  test("returns null for a plist without a usable name", () => {
    expect(appLabelFromInfoPlist({ CFBundleExecutable: "Foo" })).toBeNull();
    expect(appLabelFromInfoPlist({ CFBundleDisplayName: "  ", CFBundleName: 7 })).toBeNull();
    expect(appLabelFromInfoPlist(null)).toBeNull();
    expect(appLabelFromInfoPlist("Safari")).toBeNull();
  });
});

describe("describeForegroundApp", () => {
  test("reads the label from the path simctl reports, even where ConfinedPath refuses it", async () => {
    expect(ConfinedPath.safeParse(join(CRYPTEX_SAFARI, "Info.plist")).success).toBe(false);
    const deps = fakeDeps(CRYPTEX_SAFARI, SAFARI);

    expect(await describeForegroundApp(UDID, "com.apple.mobilesafari", deps)).toEqual({
      isReactNative: false,
      label: "Safari",
    });
    expect(deps.plistReads).toEqual([join(CRYPTEX_SAFARI, "Info.plist")]);
  });

  test("detects React Native from a marker in the same bundle", async () => {
    const appPath = "/sim/Containers/Bundle/Application/X/Example.app";
    const deps = fakeDeps(appPath, { CFBundleDisplayName: "Example" }, ["main.jsbundle"]);

    expect(await describeForegroundApp(UDID, "com.example.app", deps)).toEqual({
      isReactNative: true,
      label: "Example",
    });
  });

  test("keeps the known React Native shells when simctl cannot answer yet", async () => {
    const deps = fakeDeps(new Error("simctl timed out"), SAFARI);

    expect(await describeForegroundApp(UDID, "host.exp.Exponent", deps)).toEqual({
      isReactNative: true,
      label: null,
    });
    expect(deps.plistReads).toEqual([]);
  });

  test("reports no label for an app simctl does not know", async () => {
    const deps = fakeDeps(null, SAFARI);

    expect(await describeForegroundApp(UDID, "com.example.gone", deps)).toEqual({
      isReactNative: false,
      label: null,
    });
    expect(deps.plistReads).toEqual([]);
  });
});
