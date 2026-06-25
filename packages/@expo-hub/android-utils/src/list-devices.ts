import { homedir } from "node:os";
import { readAvdConfig, runAvdmanagerListAvd } from "./avdmanager";
import { parseAvdList } from "./parse-avd-list";
import { resolveAvdmanagerPath } from "./sdk-paths";
import type { AndroidDevice } from "./types";

/**
 * List the Android Virtual Devices known to `avdmanager`.
 *
 * Resolves `avdmanager` from `ANDROID_HOME` / `ANDROID_SDK_ROOT` (falling back
 * to the default SDK location), runs `avdmanager list avd`, and enriches each
 * AVD with its parsed `config.ini`. Returns an empty array on any failure.
 * Never throws.
 */
export async function listDevices(): Promise<AndroidDevice[]> {
  try {
    const avdmanager = resolveAvdmanagerPath(process.env, homedir());

    const stdout = await runAvdmanagerListAvd(avdmanager);
    if (!stdout) return [];

    const blocks = parseAvdList(stdout);
    return await Promise.all(blocks.map(toAndroidDevice));
  } catch (error) {
    console.error("[android-utils] Failed to list devices:", error);
    return [];
  }
}

async function toAndroidDevice(properties: Record<string, string>): Promise<AndroidDevice> {
  const path = properties.Path ?? null;
  const config = await readAvdConfig(path);

  return {
    name: properties.Name ?? "",
    path,
    properties,
    config,
  };
}
