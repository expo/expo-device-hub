import { type ExecCommand, type ExecResult, shellEscape } from "./ios-app-details";
import { type DeviceGeoFix } from "./types";

export function simctlFailureMessage(result: ExecResult): string {
  const reason = /Reason:\s*(.+)$/m.exec(result.stderr);
  if (reason) return reason[1].trim();
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? "simctl location failed";
}

function throwOnFailure(result: ExecResult): void {
  if (result.exitCode !== 0) throw new Error(simctlFailureMessage(result));
}

export async function setIosLocation(
  exec: ExecCommand,
  udid: string,
  fix: DeviceGeoFix,
): Promise<DeviceGeoFix> {
  const coordinates = `${fix.latitude.toFixed(7)},${fix.longitude.toFixed(7)}`;
  throwOnFailure(await exec(`xcrun simctl location ${shellEscape(udid)} set ${coordinates}`));
  return fix;
}

export async function clearIosLocation(exec: ExecCommand, udid: string): Promise<void> {
  throwOnFailure(await exec(`xcrun simctl location ${shellEscape(udid)} clear`));
}
