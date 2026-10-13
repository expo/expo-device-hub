import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  androidExecutable,
  androidSdkRoots,
  type AndroidSdkLookup,
  type AndroidSdkRoot,
} from "./android-sdk";

const CMDLINE_TOOLS = "cmdline-tools";

/** Test seams for the file system checks behind the `resolve*` functions. */
export type SdkFileSystem = Pick<AndroidSdkLookup, "existsSync" | "realpathSync"> & {
  readdirSync?: (path: string) => string[];
};

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
  return resolveInSdk(env, homeDir, platform, fileSystem, (root) => [root]);
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
  return cmdlineToolPath(sdkRoot, "latest", "avdmanager", platform);
}

/**
 * Resolve the `avdmanager` path directly from the environment, with the
 * search order of {@link cmdlineToolPaths}.
 */
export function resolveAvdmanagerPath(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  fileSystem: SdkFileSystem = {},
): string {
  return resolveInSdk(env, homeDir, platform, fileSystem, (root, list) =>
    cmdlineToolPaths(root, "avdmanager", platform, list),
  );
}

/** Build the absolute path to the `sdkmanager` wrapper inside an SDK root. */
export function sdkmanagerPath(
  sdkRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return cmdlineToolPath(sdkRoot, "latest", "sdkmanager", platform);
}

/**
 * Resolve the `sdkmanager` path directly from the environment, with the
 * search order of {@link cmdlineToolPaths}.
 */
export function resolveSdkmanagerPath(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  fileSystem: SdkFileSystem = {},
): string {
  return resolveInSdk(env, homeDir, platform, fileSystem, (root, list) =>
    cmdlineToolPaths(root, "sdkmanager", platform, list),
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
  return resolveInSdk(env, homeDir, platform, fileSystem, (root) => [
    emulatorPath(root, platform),
  ]);
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
  return resolveInSdk(env, homeDir, platform, fileSystem, (root) => [adbPath(root, platform)]);
}

/**
 * Return the first of `toolPaths` that exists, trying the SDK roots in order,
 * or the first path in the first root when none exists. Each tool looks on its
 * own, because a partial SDK in `ANDROID_HOME` may lack a tool that Android
 * Studio's SDK has.
 */
function resolveInSdk(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
  { existsSync: exists = existsSync, realpathSync, readdirSync: list = listDirectory }: SdkFileSystem,
  toolPaths: (sdkRoot: string, list: (path: string) => string[]) => Iterable<string>,
): string {
  const roots = sdkRoots(env, homeDir, platform, { existsSync: exists, realpathSync });
  for (const root of roots) {
    for (const path of toolPaths(root.path, list)) {
      if (exists(path)) return path;
    }
  }
  // androidSdkRoots always ends with the platform's default folder.
  const [fallback] = toolPaths(roots[0]!.path, list);
  return fallback!;
}

/**
 * The places a command-line tool may sit in one SDK root, in search order:
 * `cmdline-tools/latest/bin`, which Android Studio installs, then each
 * numbered `cmdline-tools/<version>/bin`, newest first. The old `tools/bin`
 * layout is left out on purpose until someone reports that they need it.
 */
function* cmdlineToolPaths(
  sdkRoot: string,
  tool: string,
  platform: NodeJS.Platform,
  list: (path: string) => string[],
): Generator<string> {
  yield cmdlineToolPath(sdkRoot, "latest", tool, platform);
  const versions = list(join(sdkRoot, CMDLINE_TOOLS))
    .filter((name) => /^\d+(\.\d+)*$/.test(name))
    .sort(compareVersions)
    .reverse();
  for (const version of versions) yield cmdlineToolPath(sdkRoot, version, tool, platform);
}

function cmdlineToolPath(
  sdkRoot: string,
  version: string,
  tool: string,
  platform: NodeJS.Platform,
): string {
  return join(sdkRoot, CMDLINE_TOOLS, version, "bin", platform === "win32" ? `${tool}.bat` : tool);
}

/** Order version folder names such as `9.0` and `19.0` by number, oldest first. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function listDirectory(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
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
