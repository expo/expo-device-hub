import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { launchAppAsync } from "../launch-app";
import { useTempStateDir, withShimsAsync } from "./helpers";

const UDID = "LAUNCH-APP-TEST-" + process.pid;
const BUNDLE_ID = "com.example.app";
const LAUNCH_ARGS = ["--flag", "space and $(literal)"];
const OPEN_URL = "example://startup";

describe("launchAppAsync", () => {
  for (const diagnostic of ["", "could not reach simulator", "could not terminate running application"]) {
    test(diagnostic || "restarts once with literal arguments before approving and opening the URL", async () => {
      const state = useTempStateDir();
      const log = join(state.dir, "commands.jsonl");
      writeFileSync(log, "");
      try {
        await withShimsAsync({ xcrun: `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[1] === 'launch' && ${JSON.stringify(diagnostic)}) {
  console.error(${JSON.stringify(diagnostic)});
  process.exit(1);
}
` }, async () => {
          const launching = launchAppAsync(UDID, { bundleId: BUNDLE_ID, launchArgs: LAUNCH_ARGS, openUrl: OPEN_URL });
          if (diagnostic) {
            await expect(launching).rejects.toThrow(diagnostic);
            await expect(launching).rejects.toThrow(UDID);
          } else await launching;
          const calls = readFileSync(log, "utf8").trim().split("\n")
            .map((line) => JSON.parse(line) as string[])
            .filter((args) => args[1] === "launch" || args[1] === "terminate" || args[1] === "openurl"
              || (args[1] === "spawn" && args[3] === "defaults"));
          expect(calls).toEqual([
            ["simctl", "launch", "--terminate-running-process", UDID, BUNDLE_ID, ...LAUNCH_ARGS],
            ...(diagnostic ? [] : [
              ["simctl", "spawn", UDID, "defaults", "write", "com.apple.launchservices.schemeapproval",
                "com.apple.CoreSimulator.CoreSimulatorBridge-->example", "-string", BUNDLE_ID],
              ["simctl", "openurl", UDID, OPEN_URL],
            ]),
          ]);
        });
      } finally {
        state.restore();
      }
    });
  }
});
