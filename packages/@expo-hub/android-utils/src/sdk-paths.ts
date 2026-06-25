import { join } from "node:path";

const DEFAULT_SDK_SUBPATH = "Library/Android/sdk";
const AVDMANAGER_SUBPATH = "cmdline-tools/latest/bin/avdmanager";

/**
 * Resolve the Android SDK root from the environment.
 *
 * Prefers `ANDROID_HOME`, then the deprecated `ANDROID_SDK_ROOT`, and finally
 * the default macOS location under the user's home directory.
 */
export function resolveSdkRoot(env: NodeJS.ProcessEnv, homeDir: string): string {
  const androidHome = nonEmpty(env.ANDROID_HOME);
  if (androidHome) return androidHome;

  const sdkRoot = nonEmpty(env.ANDROID_SDK_ROOT);
  if (sdkRoot) return sdkRoot;

  return join(homeDir, DEFAULT_SDK_SUBPATH);
}

/** Build the absolute path to the `avdmanager` binary inside an SDK root. */
export function avdmanagerPath(sdkRoot: string): string {
  return join(sdkRoot, AVDMANAGER_SUBPATH);
}

/** Resolve the `avdmanager` path directly from the environment. */
export function resolveAvdmanagerPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  return avdmanagerPath(resolveSdkRoot(env, homeDir));
}

function nonEmpty(value: string | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
