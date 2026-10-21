import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adbCommand, clearAdbCommandCache, resolveAdbCommand } from "../src/adb-command.ts";
import type { AndroidSdkLookup } from "../src/android-sdk.ts";

const HOME = "/Users/test";

function lookup(
  env: NodeJS.ProcessEnv,
  files: string[],
  platform: NodeJS.Platform = "darwin",
): AndroidSdkLookup {
  return {
    env,
    platform,
    homeDir: HOME,
    existsSync: (path) => files.includes(path),
    realpathSync: (path) => path,
  };
}

afterEach(() => {
  clearAdbCommandCache();
  setSystemTime();
});

describe("resolveAdbCommand", () => {
  test("takes adb from ANDROID_HOME before the SDK of the adb on PATH", () => {
    const files = ["/sdk/home/platform-tools/adb", "/sdk/path/platform-tools/adb"];
    const env = { ANDROID_HOME: "/sdk/home", PATH: "/sdk/path/platform-tools" };
    expect(resolveAdbCommand(lookup(env, files))).toBe("/sdk/home/platform-tools/adb");
  });

  test("finds Android Studio's SDK without ANDROID_HOME or adb on PATH", () => {
    const files = ["/Users/test/Library/Android/sdk/platform-tools/adb"];
    expect(resolveAdbCommand(lookup({ PATH: "/usr/bin" }, files))).toBe(
      "/Users/test/Library/Android/sdk/platform-tools/adb",
    );
  });

  test("skips an SDK without platform-tools", () => {
    const files = ["/Users/test/Library/Android/sdk/platform-tools/adb"];
    expect(resolveAdbCommand(lookup({ ANDROID_HOME: "/sdk/partial" }, files))).toBe(
      "/Users/test/Library/Android/sdk/platform-tools/adb",
    );
  });

  test("falls back to adb on PATH when no SDK has it", () => {
    expect(resolveAdbCommand(lookup({ PATH: "/usr/bin" }, []))).toBe("adb");
  });

  test("looks for adb.exe on Windows", () => {
    const files = ["C:\\Android\\platform-tools\\adb.exe"];
    expect(resolveAdbCommand(lookup({ ANDROID_HOME: "C:\\Android" }, files, "win32"))).toEndWith(
      "adb.exe",
    );
  });
});

describe("adbCommand", () => {
  let sdk: string | null = null;

  afterEach(async () => {
    if (sdk) await rm(sdk, { recursive: true, force: true });
    sdk = null;
  });

  async function sdkWithAdb(): Promise<string> {
    sdk = await mkdtemp(join(tmpdir(), "serve-emu-adb-"));
    await mkdir(join(sdk, "platform-tools"));
    await writeFile(join(sdk, "platform-tools", "adb"), "");
    return sdk;
  }

  test("resolves once while the environment stays the same", async () => {
    const root = await sdkWithAdb();
    const env = { ANDROID_HOME: root, PATH: "", HOME: "/nonexistent" };
    expect(adbCommand(env)).toBe(join(root, "platform-tools", "adb"));

    await rm(join(root, "platform-tools", "adb"));
    expect(adbCommand(env)).toBe(join(root, "platform-tools", "adb"));
    expect(adbCommand({ ...env, ANDROID_SDK_ROOT: "/other" })).toBe("adb");
  });

  test("resolves again after 10 seconds or when the clock moves back", async () => {
    const root = await sdkWithAdb();
    const env = { ANDROID_HOME: root, PATH: "", HOME: "/nonexistent" };
    setSystemTime(new Date("2026-10-13T12:00:00Z"));
    expect(adbCommand(env)).toBe(join(root, "platform-tools", "adb"));

    await rm(join(root, "platform-tools", "adb"));
    setSystemTime(new Date("2026-10-13T12:00:09Z"));
    expect(adbCommand(env)).toBe(join(root, "platform-tools", "adb"));
    setSystemTime(new Date("2026-10-13T12:00:10Z"));
    expect(adbCommand(env)).toBe("adb");

    await writeFile(join(root, "platform-tools", "adb"), "");
    setSystemTime(new Date("2026-10-13T11:00:00Z"));
    expect(adbCommand(env)).toBe(join(root, "platform-tools", "adb"));
  });
});
