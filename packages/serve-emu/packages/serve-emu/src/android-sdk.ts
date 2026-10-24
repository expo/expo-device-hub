import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

// Finds the Android SDK folders that may hold a tool (adb, emulator, aapt2, avdmanager, ...).
// serve-emu and @expo/hub-android-utils each carry a byte-identical copy of this file, because the
// Hub vendors serve-emu with `npm pack` and serve-emu cannot depend on a private workspace package.
// serve-emu's android-sdk-sync test fails when the copies diverge.

export interface AndroidSdkLookup {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  existsSync?: (path: string) => boolean;
  realpathSync?: (path: string) => string;
}

export interface AndroidSdkRoot {
  path: string;
  /** Where the folder came from, for messages: `ANDROID_HOME`, `adb on PATH`, ... */
  source: string;
}

/** A tool on PATH whose parent folder sits directly in the SDK root. */
const SDK_TOOLS_ON_PATH = [
  { tool: "adb", folder: "platform-tools" },
  { tool: "emulator", folder: "emulator" },
] as const;

/** Tells the user what to do when a tool is in none of the {@link androidSdkRoots}. */
export const ANDROID_SDK_HINT = "Set ANDROID_HOME to your Android SDK folder.";

/**
 * The candidate Android SDK roots, most specific first, without duplicates:
 *
 * 1. `ANDROID_HOME`, then the deprecated `ANDROID_SDK_ROOT`.
 * 2. The SDK that holds the `adb` or `emulator` found on PATH, after symlinks.
 * 3. Android Studio's default folder for the platform. Linux checks `Sdk` and
 *    `sdk`, because its paths are case-sensitive and tools disagree on the case.
 *
 * The roots are not checked: a caller looks for its tool in each one, in order.
 */
export function androidSdkRoots({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  existsSync: exists = existsSync,
  realpathSync: realpath = realpathSync,
}: AndroidSdkLookup = {}): AndroidSdkRoot[] {
  const roots: AndroidSdkRoot[] = [];
  const add = (path: string | undefined, source: string) => {
    const trimmed = path?.trim();
    if (trimmed && !roots.some((root) => root.path === trimmed)) {
      roots.push({ path: trimmed, source });
    }
  };

  add(env.ANDROID_HOME, "ANDROID_HOME");
  add(env.ANDROID_SDK_ROOT, "ANDROID_SDK_ROOT");
  for (const root of sdkRootsOnPath(env, platform, exists, realpath)) add(root.path, root.source);
  for (const path of defaultSdkRoots(env, platform, homeDir)) {
    add(path, "default location");
  }
  return roots;
}

/** The file name of an SDK executable: Windows adds `.exe`. */
export function androidExecutable(
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? `${name}.exe` : name;
}

/** List the roots for an error message: `ANDROID_HOME (/sdk), default location (/home/sdk)`. */
export function describeAndroidSdkRoots(roots: readonly AndroidSdkRoot[]): string {
  return roots.map((root) => `${root.source} (${root.path})`).join(", ");
}

function sdkRootsOnPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
  realpath: (path: string) => string,
): AndroidSdkRoot[] {
  const path = platform === "win32" ? win32 : posix;
  const directories = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);

  const roots: AndroidSdkRoot[] = [];
  for (const directory of directories) {
    for (const { tool, folder } of SDK_TOOLS_ON_PATH) {
      const file = path.join(directory, androidExecutable(tool, platform));
      if (!exists(file)) continue;
      // Package managers link the tool into a shared bin folder, so look past the link.
      const resolved = resolveLink(realpath, file);
      const parent = path.dirname(resolved);
      if (path.basename(parent).toLowerCase() === folder) {
        roots.push({ path: path.dirname(parent), source: `${tool} on PATH` });
      }
    }
  }
  return roots;
}

function resolveLink(realpath: (path: string) => string, file: string): string {
  try {
    return realpath(file);
  } catch {
    return file;
  }
}

/** Where Android Studio installs the SDK when the user accepts its default. */
function defaultSdkRoots(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDir: string,
): string[] {
  if (platform === "darwin") return [posix.join(homeDir, "Library", "Android", "sdk")];
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || win32.join(homeDir, "AppData", "Local");
    return [win32.join(localAppData, "Android", "Sdk")];
  }
  // eas-cli uses `Sdk`, Expo CLI uses `sdk`.
  return [posix.join(homeDir, "Android", "Sdk"), posix.join(homeDir, "Android", "sdk")];
}
