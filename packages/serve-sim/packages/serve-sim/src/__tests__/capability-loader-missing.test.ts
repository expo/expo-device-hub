import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { armCapabilityLoader, capabilityLoaderPath, rearmCapabilityLoader } from "../launch-manager";
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
