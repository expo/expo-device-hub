import { describe, expect, test } from "bun:test";
import {
  androidExecutable,
  androidSdkRoots,
  describeAndroidSdkRoots,
  type AndroidSdkLookup,
} from "../src/android-sdk.ts";

const HOME = "/Users/test";

function lookup(
  env: NodeJS.ProcessEnv,
  files: Record<string, string> = {},
  platform: NodeJS.Platform = "darwin",
): AndroidSdkLookup {
  return {
    env,
    platform,
    homeDir: HOME,
    existsSync: (path) => path in files,
    realpathSync: (path) => files[path] ?? path,
  };
}

describe("androidSdkRoots", () => {
  test("orders ANDROID_HOME, ANDROID_SDK_ROOT, PATH, then the default folder", () => {
    const roots = androidSdkRoots(
      lookup(
        {
          ANDROID_HOME: "/sdk/home",
          ANDROID_SDK_ROOT: "/sdk/root",
          PATH: "/sdk/path/platform-tools",
        },
        { "/sdk/path/platform-tools/adb": "/sdk/path/platform-tools/adb" },
      ),
    );
    expect(roots).toEqual([
      { path: "/sdk/home", source: "ANDROID_HOME" },
      { path: "/sdk/root", source: "ANDROID_SDK_ROOT" },
      { path: "/sdk/path", source: "adb on PATH" },
      { path: "/Users/test/Library/Android/sdk", source: "default location" },
    ]);
  });

  test("finds Android Studio's SDK from adb on PATH when no variable is set", () => {
    // The reported setup: PATH spells `Sdk`, the folder is `sdk`, and build-tools is not on PATH.
    const platformTools = "/Users/test/Library/Android/Sdk/platform-tools";
    const emulator = "/Users/test/Library/Android/Sdk/emulator";
    const roots = androidSdkRoots(
      lookup(
        { PATH: `/usr/bin:${platformTools}:${emulator}` },
        {
          [`${platformTools}/adb`]: `${platformTools}/adb`,
          [`${emulator}/emulator`]: `${emulator}/emulator`,
        },
      ),
    );
    expect(roots[0]).toEqual({ path: "/Users/test/Library/Android/Sdk", source: "adb on PATH" });
  });

  test("follows a linked tool to the SDK that holds it", () => {
    const roots = androidSdkRoots(
      lookup(
        { PATH: "/opt/homebrew/bin" },
        { "/opt/homebrew/bin/emulator": "/opt/android-sdk/emulator/emulator" },
      ),
    );
    expect(roots[0]).toEqual({ path: "/opt/android-sdk", source: "emulator on PATH" });
  });

  test("ignores a tool on PATH that is not in an SDK folder", () => {
    const roots = androidSdkRoots(
      lookup({ PATH: "/opt/homebrew/bin" }, { "/opt/homebrew/bin/adb": "/opt/homebrew/bin/adb" }),
    );
    expect(roots).toEqual([
      { path: "/Users/test/Library/Android/sdk", source: "default location" },
    ]);
  });

  test("keeps the tool path when the link cannot be read", () => {
    const roots = androidSdkRoots({
      ...lookup({ PATH: "/sdk/platform-tools" }),
      existsSync: () => true,
      realpathSync: () => {
        throw new Error("EACCES");
      },
    });
    expect(roots[0]).toEqual({ path: "/sdk", source: "adb on PATH" });
  });

  test("ignores empty variables, trims values, and drops duplicates", () => {
    expect(
      androidSdkRoots(lookup({ ANDROID_HOME: "  /sdk  ", ANDROID_SDK_ROOT: "/sdk", PATH: "" })),
    ).toEqual([
      { path: "/sdk", source: "ANDROID_HOME" },
      { path: "/Users/test/Library/Android/sdk", source: "default location" },
    ]);
    expect(androidSdkRoots(lookup({ ANDROID_HOME: "   ", ANDROID_SDK_ROOT: "" }))).toEqual([
      { path: "/Users/test/Library/Android/sdk", source: "default location" },
    ]);
  });

  test("uses Android Studio's default folder for each platform", () => {
    const defaultRoots = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
      androidSdkRoots(lookup(env, {}, platform)).map((root) => root.path);
    expect(defaultRoots({}, "darwin")).toEqual(["/Users/test/Library/Android/sdk"]);
    // Linux paths are case-sensitive, and tools disagree on the case.
    expect(defaultRoots({}, "linux")).toEqual([
      "/Users/test/Android/Sdk",
      "/Users/test/Android/sdk",
    ]);
    expect(defaultRoots({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "win32")).toEqual([
      "C:\\Users\\test\\AppData\\Local\\Android\\Sdk",
    ]);
    expect(defaultRoots({}, "win32")).toEqual(["\\Users\\test\\AppData\\Local\\Android\\Sdk"]);
  });

  test("reads the Windows PATH with its own separator and file names", () => {
    const roots = androidSdkRoots(
      lookup(
        { Path: "C:\\Windows;C:\\Android\\platform-tools" },
        { "C:\\Android\\platform-tools\\adb.exe": "C:\\Android\\platform-tools\\adb.exe" },
        "win32",
      ),
    );
    expect(roots[0]).toEqual({ path: "C:\\Android", source: "adb on PATH" });
  });
});

describe("androidExecutable", () => {
  test("adds .exe on Windows only", () => {
    expect(androidExecutable("aapt2", "win32")).toBe("aapt2.exe");
    expect(androidExecutable("aapt2", "darwin")).toBe("aapt2");
    expect(androidExecutable("aapt2", "linux")).toBe("aapt2");
  });
});

describe("describeAndroidSdkRoots", () => {
  test("names the source and the path of each root", () => {
    expect(
      describeAndroidSdkRoots([
        { path: "/sdk", source: "ANDROID_HOME" },
        { path: "/Users/test/Library/Android/sdk", source: "default location" },
      ]),
    ).toBe("ANDROID_HOME (/sdk), default location (/Users/test/Library/Android/sdk)");
  });
});
