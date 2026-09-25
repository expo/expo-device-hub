import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dirnameOf } from "../runtime";
import { simctl } from "../simctl";

const __dirname = dirnameOf(import.meta.url);
const DYLIB_NAME = "libSimNetProxy.dylib";

/**
 * Unused until #53 reads it. Remove the tag there.
 * @public
 */
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

/**
 * Unused until #53 reads it. Remove the tag there.
 * @public
 */
export function locateProxyDylib(): string | null {
  return proxyDylibCandidates().find((candidate) => existsSync(candidate)) ?? null;
}
