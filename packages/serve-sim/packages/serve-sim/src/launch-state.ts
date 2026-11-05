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
  /** Empty keeps the capability alive after a one-shot command exits. */
  ownerPids: number[];
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
    ...Object.values(raw.capabilities ?? {}).flatMap((record: any) => {
      if (!record || typeof record !== "object" || Array.isArray(record))
        throw new Error(`Cannot read ownership for Simulator ${udid}.`);
      if (!("ownerPids" in record)) return [record.ownerPid];
      if (
        !Array.isArray(record.ownerPids) ||
        record.ownerPids.some((pid: unknown) => !Number.isInteger(pid) || (pid as number) <= 1)
      )
        throw new Error(`Cannot read ownership for Simulator ${udid}.`);
      // A one-shot capability is persistent, just as legacy ownerPid: null was.
      return record.ownerPids.length > 0 ? record.ownerPids : [null];
    }),
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
    const { ownerPid: legacyOwnerPid, ...rest } = record as RecordedCapability & {
      ownerPid?: number | null;
    };
    const { name, dylib, scope, bundleId, ownerPids } = rest;
    if (typeof name !== "string" || typeof dylib !== "string" || !isCapabilityScope(scope)) {
      continue;
    }
    const declared = Array.isArray(ownerPids)
      ? ownerPids
      : typeof legacyOwnerPid === "number"
        ? [legacyOwnerPid]
        : [];
    const owners = declared.filter(
      (pid) => Number.isInteger(pid) && pid > 0 && (pid === retainOwnerPid || !ownerIsGone(pid)),
    );
    if (declared.length > 0 && owners.length === 0) continue;
    kept[key] = {
      ...rest,
      bundleId: typeof bundleId === "string" ? bundleId : null,
      ownerPids: owners,
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
