import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { androidExecutable, androidSdkRoots, type AndroidSdkLookup } from "./android-sdk.ts";

/**
 * serve-emu runs adb for most API calls, so the resolved command is kept until
 * an input changes or this much time passes. The time limit finds an SDK
 * installed while serve-emu runs.
 */
const ADB_COMMAND_CACHE_MS = 10_000;

let adbCommandCache: { key: string; command: string; resolvedAt: number } | null = null;

/**
 * The `adb` to run: `platform-tools/adb` in the first Android SDK root that has
 * it, else `adb` from PATH. The roots come in the same order as in
 * @expo/hub-android-utils, so the Hub and serve-emu start the same adb file.
 */
export function resolveAdbCommand({
  platform = process.platform,
  existsSync: exists = existsSync,
  ...lookup
}: AndroidSdkLookup = {}): string {
  const path = platform === "win32" ? win32 : posix;
  const executable = androidExecutable("adb", platform);
  for (const root of androidSdkRoots({ ...lookup, platform, existsSync: exists })) {
    const candidate = path.join(root.path, "platform-tools", executable);
    if (exists(candidate)) return candidate;
  }
  return "adb";
}

/** {@link resolveAdbCommand} for this process's environment, cached. */
export function adbCommand(env: NodeJS.ProcessEnv = process.env): string {
  const key = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    env.PATH ?? env.Path,
    env.LOCALAPPDATA,
    env.HOME,
  ].join("\0");
  const now = Date.now();
  // A clock set back makes the age negative, which also resolves again.
  const age = adbCommandCache ? now - adbCommandCache.resolvedAt : 0;
  if (adbCommandCache?.key !== key || age < 0 || age >= ADB_COMMAND_CACHE_MS) {
    adbCommandCache = {
      key,
      command: resolveAdbCommand({ env, homeDir: env.HOME }),
      resolvedAt: now,
    };
  }
  return adbCommandCache.command;
}

/** Forget the cached adb command, for tests. */
export function clearAdbCommandCache(): void {
  adbCommandCache = null;
}
