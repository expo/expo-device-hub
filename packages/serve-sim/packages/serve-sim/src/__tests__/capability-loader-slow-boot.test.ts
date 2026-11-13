import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { capabilityLoaderPath, rearmCapabilityLoader } from "../launch-manager";
import { useTempStateDir, withShimsAsync } from "./helpers";

const UDID = "11111111-2222-3333-4444-555555555555";

// After an iOS 27 boot, a loaded CI host can take more than 15 s for one `simctl spawn`.
test("rearming after a boot waits for a launchctl call slower than 15 s", async () => {
  const state = useTempStateDir();
  const insert = join(state.dir, "insert");
  const reads = join(state.dir, "reads");
  writeFileSync(insert, "");
  writeFileSync(reads, "0");
  try {
    await withShimsAsync(
      {
        xcrun: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const insert = ${JSON.stringify(insert)};
const reads = ${JSON.stringify(reads)};
const answer = () => {
  if (args[4] === 'getenv' && args[5] === 'DYLD_INSERT_LIBRARIES') console.log(fs.readFileSync(insert, 'utf8'));
  if (args[4] === 'setenv' && args[5] === 'DYLD_INSERT_LIBRARIES') fs.writeFileSync(insert, args[6]);
};
if (args[4] === 'getenv' && args[5] === 'DYLD_INSERT_LIBRARIES') {
  const n = Number(fs.readFileSync(reads, 'utf8')) + 1;
  fs.writeFileSync(reads, String(n));
  if (n === 1) { setTimeout(answer, 16_000); return; }
}
answer();
`,
      },
      async () => {
        await rearmCapabilityLoader(UDID);
        expect(readFileSync(insert, "utf8").split(":")).toContain(capabilityLoaderPath());
      },
    );
  } finally {
    state.restore();
  }
}, 40_000);
