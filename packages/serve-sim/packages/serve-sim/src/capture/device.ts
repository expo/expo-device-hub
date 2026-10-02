import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isCapabilityArmed } from "../launch-manager";
import { dirnameOf } from "../runtime";
import { simctl } from "../simctl";

const __dirname = dirnameOf(import.meta.url);
const DYLIB_NAME = "libSimNetProxy.dylib";

export async function trustCaInSimulator(udid: string, caPem: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-ca-"));
  const certPath = join(dir, "capture-root.crt");
  try {
    writeFileSync(certPath, caPem);
    await simctl(["keychain", udid, "add-root-cert", certPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function proxyDylibCandidates(): string[] {
  return [
    join(__dirname, "simnet", DYLIB_NAME),
    join(__dirname, "..", "dist", "simnet", DYLIB_NAME),
    join(__dirname, "..", "..", "dist", "simnet", DYLIB_NAME),
  ];
}

export function locateProxyDylib(): string | null {
  return proxyDylibCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

export async function isDeviceInjected(
  udid: string,
  portFile: string,
  deps: { read?: (args: string[]) => Promise<string>; expectedPort?: number } = {},
): Promise<boolean> {
  let port: number;
  try {
    port = Number(readFileSync(portFile, "utf8").trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      (deps.expectedPort !== undefined && port !== deps.expectedPort)) return false;
  return isCapabilityArmed(udid, "networkCapture", { SIMNET_PROXY_PORT_FILE: portFile }, deps.read);
}
