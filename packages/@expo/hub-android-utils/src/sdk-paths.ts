import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  androidExecutable,
  androidSdkRoots,
  type AndroidSdkLookup,
  type AndroidSdkRoot,
} from "./android-sdk";

const AVDMANAGER_SUBPATH = "cmdline-tools/latest/bin/avdmanager";
const SDKMANAGER_SUBPATH = "cmdline-tools/latest/bin/sdkmanager";

/** Test seams for the file system checks behind the `resolve*` functions. */
export type SdkFileSystem = Pick<AndroidSdkLookup, "existsSync" | "realpathSync">;

/**
 * The device list polls every 500 ms and resolves two tools each time. The
 * roots come from a PATH scan, so they are kept until an input changes or this
 * much time passes. The time limit finds an SDK installed into a folder that
 * is already on PATH.
 */
const SDK_ROOTS_CACHE_MS = 10_000;

let sdkRootsCache: { key: string; roots: AndroidSdkRoot[]; scannedAt: number } | null = null;

/** Forget the cached SDK roots, for tests. */
export function clearSdkRootsCache(): void {
  sdkRootsCache = null;
}

/**
 * Resolve the Android SDK root from the environment.
 *
 * Returns the first of {@link androidSdkRoots} that exists: `ANDROID_HOME`,
 * the deprecated `ANDROID_SDK_ROOT`, the SDK that holds `adb` or `emulator`
 * on PATH, and Android Studio's default folder for the platform. When none
 * exists, returns the first candidate, so the error names the expected path.
 */
export function resolveSdkRoot(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  fileSystem: SdkFileSystem = {},
): string {
  return resolveInSdk(env, homeDir, platform, fileSystem, (root) => root);
}

/**
 * Build the absolute path to the `avdmanager` wrapper inside an SDK root.
 *
 * The cmdline-tools ship as `.bat` wrappers on Windows. `adb` and `emulator`
 * carry `.exe`, which the `resolve*` functions need to see that they exist.
 */
export function avdmanagerPath(
  sdkRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(sdkRoot, cmdlineTool(AVDMANAGER_SUBPATH, platform));
}

/** Resolve the `avdmanager` path directly from the environment. */
export function resolveAvdmanagerPath(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  fileSystem: SdkFileSystem = {},
): string {
  return resolveInSdk(env, homeDir, platform, fileSystem, (root) =>
    avdmanagerPath(root, platform),
  );
}

/** Build the absolute path to the `sdkmanager` wrapper inside an SDK root. */
export function sdkmanagerPath(
  sdkRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(sdkRoot, cmdlineTool(SDKMANAGER_SUBPATH, platform));
}

/** Resolve the `sdkmanager` path directly from the environment. */
export function resolveSdkmanagerPath(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  fileSystem: SdkFileSystem = {},
): string {
  return resolveInSdk(env, homeDir, platform, fileSystem, (root) =>
    sdkmanagerPath(root, platform),
  );
}

/** Build the absolute path to the `emulator` binary inside an SDK root. */
export function emulatorPath(sdkRoot: string, platform: NodeJS.Platform = process.platform): string {
  return join(sdkRoot, "emulator", androidExecutable("emulator", platform));
}

/** Resolve the `emulator` path directly from the environment. */
export function resolveEmulatorPath(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  fileSystem: SdkFileSystem = {},
): string {
  return resolveInSdk(env, homeDir, platform, fileSystem, (root) => emulatorPath(root, platform));
}

/** Build the absolute path to the `adb` binary inside an SDK root. */
export function adbPath(sdkRoot: string, platform: NodeJS.Platform = process.platform): string {
  return join(sdkRoot, "platform-tools", androidExecutable("adb", platform));
}

/** Resolve the `adb` path directly from the environment. */
export function resolveAdbPath(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  fileSystem: SdkFileSystem = {},
): string {
  return resolveInSdk(env, homeDir, platform, fileSystem, (root) => adbPath(root, platform));
}

/**
 * Return `toolPath` in the first SDK root where it exists, or in the first
 * root when it exists in none. Each tool looks on its own, because a partial
 * SDK in `ANDROID_HOME` may lack a tool that Android Studio's SDK has.
 */
function resolveInSdk(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
  { existsSync: exists = existsSync, realpathSync }: SdkFileSystem,
  toolPath: (sdkRoot: string) => string,
): string {
  const paths = sdkRoots(env, homeDir, platform, { existsSync: exists, realpathSync }).map((root) =>
    toolPath(root.path),
  );
  // androidSdkRoots always ends with the platform's default folder.
  return paths.find((path) => exists(path)) ?? paths[0]!;
}

function sdkRoots(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
  fileSystem: SdkFileSystem,
): AndroidSdkRoot[] {
  const key = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    env.PATH ?? env.Path,
    env.LOCALAPPDATA,
    homeDir,
    platform,
  ].join("\0");
  const now = Date.now();
  // A clock set back makes the age negative, which also rescans.
  const age = sdkRootsCache ? now - sdkRootsCache.scannedAt : 0;
  if (sdkRootsCache?.key !== key || age < 0 || age >= SDK_ROOTS_CACHE_MS) {
    sdkRootsCache = {
      key,
      roots: androidSdkRoots({ env, homeDir, platform, ...fileSystem }),
      scannedAt: now,
    };
  }
  return sdkRootsCache.roots;
}

function cmdlineTool(subpath: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${subpath}.bat` : subpath;
}
