import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { stateDir } from "./state";

export class DeviceInUseError extends Error {}

function lockFile(udid: string): string {
  return join(stateDir(), `physical-stream-${udid.toUpperCase()}.lock`);
}

function readHolder(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function createLock(file: string): boolean {
  const pending = `${file}.${process.pid}.tmp`;
  writeFileSync(pending, String(process.pid), { mode: 0o600 });
  try {
    linkSync(pending, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(pending);
  }
}

export function physicalStreamInUseReason(pid: number): string {
  return `iPhone is streaming in another serve-sim (pid ${pid})`;
}

export function physicalStreamHolder(udid: string): number | null {
  const holder = readHolder(lockFile(udid));
  return holder !== null && holder !== process.pid && isAlive(holder) ? holder : null;
}

// @ref LLP 0027#one-stream-per-phone — a second media stream takes the phone from the first, so a second server is refused
export function claimPhysicalStream(udid: string): () => void {
  const file = lockFile(udid);
  mkdirSync(stateDir(), { recursive: true });
  for (let attempt = 0; !createLock(file); attempt++) {
    const holder = readHolder(file);
    if (holder === process.pid) break;
    if (holder !== null && isAlive(holder))
      throw new DeviceInUseError(physicalStreamInUseReason(holder));
    if (attempt === 2) throw new DeviceInUseError(`Could not claim ${udid}'s stream`);
    try {
      unlinkSync(file);
    } catch {}
  }
  return () => {
    if (readHolder(file) !== process.pid) return;
    try {
      unlinkSync(file);
    } catch {}
  };
}
