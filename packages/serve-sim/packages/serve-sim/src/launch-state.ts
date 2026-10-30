import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { CapabilityLoadPhase, CapabilityScope } from "./capabilities";
import { stateDir, stateFileForDevice } from "./state";

function isCapabilityScope(value: unknown): value is CapabilityScope {
  return value === "userApps" || value === "allApps";
}

export interface Capability {
  name: string;
  dylib: string;
  env?: Record<string, string>;
  scope: CapabilityScope;
  loadDelayMs?: number;
  loadPhase?: CapabilityLoadPhase;
}

export interface RecordedCapability extends Capability {
  /** The app to relaunch, when one was named. Never narrows what loads. */
  bundleId: string | null;
  /** Null keeps the capability alive after a one-shot command exits. */
  ownerPid: number | null;
}

export interface LaunchState {
  sessionPids?: number[];
  /** Private adoption reserves the device before boot; detached previews must leave it alone. */
  exclusivePid?: number;
  bundleId?: string;
  launchArgs: string[];
  capabilities: Record<string, RecordedCapability>;
}

function stateFile(udid: string): string {
  return join(stateDir(), `launch-${udid}.json`);
}

export function ownerIsGone(ownerPid: number | null): boolean {
  if (ownerPid === null) return false;
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch {
    return true;
  }
}

/** Call under the device lock, before reserving it or shutting it down. */
export function assertDeviceOwnership(udid: string, ownerPid: number): void {
  const launchFile = stateFile(udid);
  const raw = existsSync(launchFile) ? JSON.parse(readFileSync(launchFile, "utf8")) : {};
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (raw.sessionPids !== undefined && !Array.isArray(raw.sessionPids)) ||
    (raw.capabilities !== undefined &&
      (!raw.capabilities ||
        typeof raw.capabilities !== "object" ||
        Array.isArray(raw.capabilities)))
  ) {
    throw new Error(`Cannot read ownership for Simulator ${udid}.`);
  }
  const previewFile = stateFileForDevice(udid);
  const preview = existsSync(previewFile)
    ? JSON.parse(readFileSync(previewFile, "utf8"))
    : undefined;
  const owners = [
    ...(raw.sessionPids ?? []),
    ...Object.values(raw.capabilities ?? {}).map((record: any) => record?.ownerPid),
    ...(raw.exclusivePid === undefined ? [] : [raw.exclusivePid]),
  ];
  if (preview !== undefined) owners.push(preview?.pid);
  if (owners.some((pid) => pid !== null && (!Number.isInteger(pid) || pid <= 1)))
    throw new Error(`Cannot read ownership for Simulator ${udid}.`);
  if (owners.some((pid) => pid !== ownerPid && !ownerIsGone(pid)))
    throw new Error(`Cannot use Simulator ${udid}: another session still owns it.`);
}

export function readLaunchState(udid: string, retainOwnerPid?: number): LaunchState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stateFile(udid), "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { bundleId, launchArgs, capabilities, sessionPids, exclusivePid } =
    parsed as Partial<LaunchState>;
  return {
    ...(exclusivePid === undefined ? {} : { exclusivePid }),
    ...(typeof bundleId === "string" && bundleId ? { bundleId } : {}),
    launchArgs: Array.isArray(launchArgs)
      ? launchArgs.filter((arg): arg is string => typeof arg === "string")
      : [],
    capabilities: recordedCapabilities(capabilities, retainOwnerPid),
    ...(Array.isArray(sessionPids)
      ? {
          sessionPids: sessionPids.filter(
            (pid) => Number.isInteger(pid) && pid > 0 && !ownerIsGone(pid),
          ),
        }
      : {}),
  };
}

// Discard malformed records and capabilities whose owner has exited.
function recordedCapabilities(
  value: unknown,
  retainOwnerPid?: number,
): Record<string, RecordedCapability> {
  if (typeof value !== "object" || value === null) return {};
  const kept: Record<string, RecordedCapability> = {};
  for (const [key, record] of Object.entries(value)) {
    if (typeof record !== "object" || record === null) continue;
    const { name, dylib, scope, bundleId, ownerPid } = record as Partial<RecordedCapability>;
    if (typeof name !== "string" || typeof dylib !== "string" || !isCapabilityScope(scope)) {
      continue;
    }
    const owner = typeof ownerPid === "number" ? ownerPid : null;
    if (owner !== retainOwnerPid && ownerIsGone(owner)) continue;
    kept[key] = {
      ...(record as RecordedCapability),
      bundleId: typeof bundleId === "string" ? bundleId : null,
      ownerPid: owner,
    };
  }
  return kept;
}

export function clearLaunchState(udid: string): void {
  try {
    unlinkSync(stateFile(udid));
  } catch {}
}

export function writeLaunchState(udid: string, state: LaunchState): void {
  if (!existsSync(stateDir())) mkdirSync(stateDir(), { recursive: true });
  const target = stateFile(udid);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, target);
}
