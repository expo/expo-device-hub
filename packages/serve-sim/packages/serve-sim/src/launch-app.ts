import type { CapabilityOverrides } from "./capabilities";
import { applyDefaultCapabilities, withAppLaunchState } from "./capabilities/runtime/manager";
import { withLaunchStateLock } from "./capabilities/runtime/lock";
import {
  preapproveUrlSchemeAsync,
  terminateForRelaunch,
  writeUrlSchemeApprovalAsync,
} from "./app-launch-host";
import { simctl } from "./simctl";
import { timeStartup } from "./startup-timing";

export async function launchAppAsync(
  udid: string,
  {
    bundleId,
    launchArgs,
    openUrl,
    capabilities = {},
  }: {
    bundleId: string;
    launchArgs: string[];
    openUrl?: string;
    capabilities?: CapabilityOverrides;
  },
): Promise<void> {
  await applyDefaultCapabilities(udid, bundleId, capabilities);
  await launchApp(udid, { bundleId, launchArgs, restart: true, openUrl });
}

export async function launchApp(
  udid: string,
  {
    bundleId,
    launchArgs = [],
    restart = false,
    openUrl,
  }: { bundleId: string; launchArgs?: string[]; restart?: boolean; openUrl?: string },
): Promise<void> {
  await withAppLaunchState(
    udid,
    bundleId,
    launchArgs,
    async () => {
      if (restart)
        await timeStartup("app.launch.terminate", () => terminateForRelaunch(udid, bundleId), udid);
      await simctl(["launch", udid, bundleId, ...launchArgs]);
    },
    openUrl ? () => openUrlInAppUnlocked(udid, bundleId, openUrl) : undefined,
  );
}

async function openUrlInAppUnlocked(
  udid: string,
  bundleId: string,
  openUrl: string,
): Promise<void> {
  await preapproveUrlSchemeAsync(udid, bundleId, openUrl);
  await simctl(["openurl", udid, openUrl]);
}

export async function openUrlInApp(udid: string, bundleId: string, openUrl: string): Promise<void> {
  await withLaunchStateLock(udid, () => openUrlInAppUnlocked(udid, bundleId, openUrl));
}

export async function approveUrlScheme(
  udid: string,
  bundleId: string,
  scheme: string,
): Promise<void> {
  await withLaunchStateLock(udid, () => writeUrlSchemeApprovalAsync(udid, bundleId, scheme));
}

export async function stopApp(udid: string, bundleId: string): Promise<void> {
  await withLaunchStateLock(udid, () => simctl(["terminate", udid, bundleId]));
}
