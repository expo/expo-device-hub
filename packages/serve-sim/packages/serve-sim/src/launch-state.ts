import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { CapabilityScope } from "./capabilities";
import { stateDir } from "./state";

function isCapabilityScope(value: unknown): value is CapabilityScope {
  return value === "userApps" || value === "allApps";
}

export interface Capability {
  name: string;
  dylib: string;
  env?: Record<string, string>;
  scope: CapabilityScope;
  loadDelayMs?: number;
}

export interface RecordedCapability extends Capability {
  /** The app to relaunch, when one was named. Never narrows what loads. */
  bundleId: string | null;
  /** Empty keeps the capability alive after a one-shot command exits. */
  ownerPids: number[];
}

export interface LaunchState {
  sessionPids?: number[];
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

export function readLaunchState(udid: string, retainOwnerPid?: number): LaunchState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stateFile(udid), "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { bundleId, launchArgs, capabilities, sessionPids } = parsed as Partial<LaunchState>;
  return {
    ...(typeof bundleId === "string" && bundleId ? { bundleId } : {}),
    launchArgs: Array.isArray(launchArgs)
      ? launchArgs.filter((arg): arg is string => typeof arg === "string")
      : [],
    capabilities: recordedCapabilities(capabilities, retainOwnerPid),
    ...(Array.isArray(sessionPids) ? { sessionPids: sessionPids.filter(
      (pid) => Number.isInteger(pid) && pid > 0 && !ownerIsGone(pid),
    ) } : {}),
  };
}

// Discard malformed records and capabilities whose owner has exited.
function recordedCapabilities(value: unknown, retainOwnerPid?: number): Record<string, RecordedCapability> {
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
  try { unlinkSync(stateFile(udid)); } catch {}
}

export function writeLaunchState(udid: string, state: LaunchState): void {
  if (!existsSync(stateDir())) mkdirSync(stateDir(), { recursive: true });
  const target = stateFile(udid);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, target);
}

