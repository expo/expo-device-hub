import type { CapabilityOverrides } from "./capabilities";
import { applyDefaultCapabilities, launchApp, openUrlInApp } from "./launch-manager";

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
  await launchApp(udid, { bundleId, launchArgs, restart: true });
  if (openUrl) await openUrlInApp(udid, bundleId, openUrl);
}
