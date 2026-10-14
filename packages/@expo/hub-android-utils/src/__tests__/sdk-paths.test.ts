import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  adbPath,
  avdmanagerPath,
  clearSdkRootsCache,
  emulatorPath,
  resolveAdbPath,
  resolveAvdmanagerPath,
  resolveEmulatorPath,
  resolveSdkmanagerPath,
  resolveSdkRoot,
  sdkmanagerPath,
  type SdkFileSystem,
} from "../sdk-paths";

const HOME = "/Users/test";

/** A file system that holds only `files`, with no links. */
function onlyFiles(...files: string[]): SdkFileSystem {
  return { existsSync: (path) => files.includes(path), realpathSync: (path) => path };
}

const EMPTY = onlyFiles();

afterEach(() => {
  clearSdkRootsCache();
  setSystemTime();
});

describe("resolveSdkRoot", () => {
  test("prefers ANDROID_HOME", () => {
    const env = { ANDROID_HOME: "/sdk/home", ANDROID_SDK_ROOT: "/sdk/root" };
    expect(resolveSdkRoot(env, HOME, "darwin", onlyFiles("/sdk/home", "/sdk/root"))).toBe(
      "/sdk/home",
    );
  });

  test("falls back to ANDROID_SDK_ROOT", () => {
    expect(resolveSdkRoot({ ANDROID_SDK_ROOT: "/sdk/root" }, HOME, "darwin", EMPTY)).toBe(
      "/sdk/root",
    );
  });

  test("skips a variable that names a missing folder", () => {
    const fileSystem = onlyFiles("/Users/test/Library/Android/sdk");
    expect(resolveSdkRoot({ ANDROID_HOME: "/missing" }, HOME, "darwin", fileSystem)).toBe(
      "/Users/test/Library/Android/sdk",
    );
  });

  test("derives the SDK from adb on PATH", () => {
    const fileSystem = onlyFiles("/opt/sdk/platform-tools/adb", "/opt/sdk");
    expect(resolveSdkRoot({ PATH: "/opt/sdk/platform-tools" }, HOME, "linux", fileSystem)).toBe(
      "/opt/sdk",
    );
  });

  test("falls back to the default SDK location of each platform", () => {
    expect(resolveSdkRoot({}, HOME, "darwin", EMPTY)).toBe("/Users/test/Library/Android/sdk");
    expect(resolveSdkRoot({}, HOME, "linux", EMPTY)).toBe("/Users/test/Android/Sdk");
  });

  test("finds a lowercase Linux SDK folder", () => {
    expect(resolveSdkRoot({}, HOME, "linux", onlyFiles("/Users/test/Android/sdk"))).toBe(
      "/Users/test/Android/sdk",
    );
  });

  test("ignores empty / whitespace env values", () => {
    const env = { ANDROID_HOME: "   ", ANDROID_SDK_ROOT: "" };
    expect(resolveSdkRoot(env, HOME, "darwin", EMPTY)).toBe("/Users/test/Library/Android/sdk");
  });

  test("trims surrounding whitespace", () => {
    expect(resolveSdkRoot({ ANDROID_HOME: "  /sdk/home  " }, HOME, "darwin", EMPTY)).toBe(
      "/sdk/home",
    );
  });
});

describe("tool resolution", () => {
  test("takes each tool from the first SDK that has it", () => {
    // ANDROID_HOME holds platform-tools only; Android Studio's SDK has the rest.
    const env = { ANDROID_HOME: "/sdk/partial" };
    const fileSystem = onlyFiles(
      "/sdk/partial/platform-tools/adb",
      "/Users/test/Library/Android/sdk/platform-tools/adb",
      "/Users/test/Library/Android/sdk/emulator/emulator",
    );
    expect(resolveAdbPath(env, HOME, "darwin", fileSystem)).toBe("/sdk/partial/platform-tools/adb");
    expect(resolveEmulatorPath(env, HOME, "darwin", fileSystem)).toBe(
      "/Users/test/Library/Android/sdk/emulator/emulator",
    );
  });

  test("scans PATH once while the environment stays the same", () => {
    const checked: string[] = [];
    const fileSystem: SdkFileSystem = {
      existsSync: (path) => {
        checked.push(path);
        return false;
      },
      realpathSync: (path) => path,
    };
    const env = { PATH: "/usr/bin" };
    resolveAdbPath(env, HOME, "darwin", fileSystem);
    resolveAvdmanagerPath(env, HOME, "darwin", fileSystem);
    expect(checked.filter((path) => path.startsWith("/usr/bin/"))).toEqual([
      "/usr/bin/adb",
      "/usr/bin/emulator",
    ]);

    resolveAdbPath({ PATH: "/opt/bin" }, HOME, "darwin", fileSystem);
    expect(checked.filter((path) => path.startsWith("/opt/bin/"))).toEqual([
      "/opt/bin/adb",
      "/opt/bin/emulator",
    ]);
  });

  test("finds an SDK installed into a PATH folder after the cache expires", () => {
    const files: string[] = [];
    const fileSystem: SdkFileSystem = {
      existsSync: (path) => files.includes(path),
      realpathSync: (path) => (path === "/opt/bin/adb" ? "/opt/android/platform-tools/adb" : path),
    };
    const env = { PATH: "/opt/bin" };
    setSystemTime(new Date("2026-10-13T00:00:00Z"));
    expect(resolveAdbPath(env, HOME, "darwin", fileSystem)).toBe(
      "/Users/test/Library/Android/sdk/platform-tools/adb",
    );

    files.push("/opt/bin/adb", "/opt/android/platform-tools/adb");
    setSystemTime(new Date("2026-10-13T00:00:09Z"));
    expect(resolveAdbPath(env, HOME, "darwin", fileSystem)).toBe(
      "/Users/test/Library/Android/sdk/platform-tools/adb",
    );

    setSystemTime(new Date("2026-10-13T00:00:10Z"));
    expect(resolveAdbPath(env, HOME, "darwin", fileSystem)).toBe(
      "/opt/android/platform-tools/adb",
    );
  });

  test("rescans when the clock moves back", () => {
    const files: string[] = [];
    const fileSystem: SdkFileSystem = {
      existsSync: (path) => files.includes(path),
      realpathSync: (path) => path,
    };
    const env = { PATH: "/opt/android/platform-tools" };
    setSystemTime(new Date("2026-10-13T12:00:00Z"));
    resolveAdbPath(env, HOME, "darwin", fileSystem);

    files.push("/opt/android/platform-tools/adb");
    setSystemTime(new Date("2026-10-13T11:00:00Z"));
    expect(resolveAdbPath(env, HOME, "darwin", fileSystem)).toBe(
      "/opt/android/platform-tools/adb",
    );
  });

  test("keeps the first SDK's path when no SDK has the tool", () => {
    expect(resolveAvdmanagerPath({ ANDROID_HOME: "/sdk/home" }, HOME, "darwin", EMPTY)).toBe(
      "/sdk/home/cmdline-tools/latest/bin/avdmanager",
    );
  });
});

describe("avdmanagerPath", () => {
  test("appends the cmdline-tools binary subpath", () => {
    expect(avdmanagerPath("/sdk", "darwin")).toBe("/sdk/cmdline-tools/latest/bin/avdmanager");
  });

  test("targets the .bat wrapper on Windows", () => {
    expect(avdmanagerPath("/sdk", "win32")).toEndWith("avdmanager.bat");
    expect(avdmanagerPath("/sdk", "linux")).toEndWith("avdmanager");
  });
});

describe("resolveAvdmanagerPath", () => {
  test("combines SDK resolution with the binary subpath", () => {
    expect(resolveAvdmanagerPath({ ANDROID_HOME: "/sdk/home" }, HOME, "darwin", EMPTY)).toBe(
      "/sdk/home/cmdline-tools/latest/bin/avdmanager",
    );
  });
});

describe("sdkmanagerPath", () => {
  test("appends the cmdline-tools binary subpath", () => {
    expect(sdkmanagerPath("/sdk", "darwin")).toBe("/sdk/cmdline-tools/latest/bin/sdkmanager");
  });

  test("targets the .bat wrapper on Windows", () => {
    expect(sdkmanagerPath("/sdk", "win32")).toEndWith("sdkmanager.bat");
    expect(resolveSdkmanagerPath({ ANDROID_HOME: "/sdk" }, HOME, "win32", EMPTY)).toEndWith(
      "sdkmanager.bat",
    );
  });
});

describe("resolveSdkmanagerPath", () => {
  test("combines SDK resolution with the binary subpath", () => {
    expect(resolveSdkmanagerPath({ ANDROID_HOME: "/sdk/home" }, HOME, "darwin", EMPTY)).toBe(
      "/sdk/home/cmdline-tools/latest/bin/sdkmanager",
    );
  });
});

describe("emulatorPath", () => {
  test("appends the emulator binary subpath", () => {
    expect(emulatorPath("/sdk", "darwin")).toBe("/sdk/emulator/emulator");
  });

  test("targets the .exe on Windows", () => {
    expect(emulatorPath("/sdk", "win32")).toEndWith("emulator.exe");
  });
});

describe("resolveEmulatorPath", () => {
  test("combines SDK resolution with the binary subpath", () => {
    expect(resolveEmulatorPath({ ANDROID_HOME: "/sdk/home" }, HOME, "darwin", EMPTY)).toBe(
      "/sdk/home/emulator/emulator",
    );
  });
});

describe("adbPath", () => {
  test("appends the platform-tools binary subpath", () => {
    expect(adbPath("/sdk", "darwin")).toBe("/sdk/platform-tools/adb");
  });

  test("targets the .exe on Windows", () => {
    expect(adbPath("/sdk", "win32")).toEndWith("adb.exe");
  });
});

describe("resolveAdbPath", () => {
  test("combines SDK resolution with the binary subpath", () => {
    expect(resolveAdbPath({ ANDROID_HOME: "/sdk/home" }, HOME, "darwin", EMPTY)).toBe(
      "/sdk/home/platform-tools/adb",
    );
  });
});
