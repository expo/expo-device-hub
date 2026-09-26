import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { armCapabilityLoader, capabilityLoaderPath, configureCapability, rearmCapabilityLoader } from "../launch-manager";
import { readLaunchState } from "../launch-state";
import { installShims, useTempStateDir } from "./helpers";

let state: ReturnType<typeof useTempStateDir>;
let shims: ReturnType<typeof installShims>;
let booted: string;

beforeEach(() => {
  state = useTempStateDir();
  booted = join(state.dir, "booted");
  writeFileSync(booted, "1");
  // Answers like simctl: fine while "booted" exists, "device is not booted" once it is gone.
  shims = installShims({ xcrun: `#!/usr/bin/env node
const fs = require('fs');
if (!fs.existsSync(${JSON.stringify(booted)})) {
  process.stderr.write('Process spawn via launchd failed because device is not booted.');
  process.exit(1);
}
` });
});

afterEach(() => {
  shims.restore();
  state.restore();
});

test.skipIf(!existsSync(capabilityLoaderPath()))("rearming fails when the loader is missing; startup arming skips it", async () => {
  const loader = capabilityLoaderPath();
  const aside = `${loader}.aside`;
  renameSync(loader, aside);
  try {
    await expect(rearmCapabilityLoader("MISSING")).rejects.toThrow("Capability loader not found");
    await expect(armCapabilityLoader("MISSING")).resolves.toBeUndefined();
  } finally {
    renameSync(aside, loader);
  }
});

test("turning a capability off works on a device shut down outside serve-sim", async () => {
  const dylib = join(state.dir, "capture.dylib");
  writeFileSync(dylib, "");
  const definition = {
    name: "networkCapture", scope: "userApps" as const, loadPhase: "startup" as const, defaultEnabled: false,
    async setEnabled({ enabled }: { enabled: boolean }) {
      return enabled ? { dylib } : null;
    },
  };
  await configureCapability("SHUT-DOWN", definition, { enabled: true, relaunch: false });
  (await import("node:fs")).unlinkSync(booted);
  await configureCapability("SHUT-DOWN", definition, { enabled: false, relaunch: false });
  expect(readLaunchState("SHUT-DOWN")?.capabilities.networkCapture).toBeUndefined();
});
