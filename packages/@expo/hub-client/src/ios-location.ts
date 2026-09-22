import { type HostActionResult, type RunHostAction } from './exec-ws';
import { type DeviceGeoFix } from './types';

/**
 * Simulated location for iOS simulators over serve-sim's typed host actions
 * (`location.set` / `location.clear`, which run `simctl location` on the host).
 * The exec channel accepts no shell commands, so the udid and coordinates travel
 * as validated parameters.
 */

export function simctlFailureMessage(result: HostActionResult): string {
  const reason = /Reason:\s*(.+)$/m.exec(result.stderr);
  if (reason) return reason[1].trim();
  const lines = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? 'simctl location failed';
}

function throwOnFailure(result: HostActionResult): void {
  if (result.exitCode !== 0) throw new Error(simctlFailureMessage(result));
}

export async function setIosLocation(
  run: RunHostAction,
  udid: string,
  fix: DeviceGeoFix,
): Promise<DeviceGeoFix> {
  throwOnFailure(await run('location.set', { udid, lat: fix.latitude, lng: fix.longitude }));
  return fix;
}

export async function clearIosLocation(run: RunHostAction, udid: string): Promise<void> {
  throwOnFailure(await run('location.clear', { udid }));
}
