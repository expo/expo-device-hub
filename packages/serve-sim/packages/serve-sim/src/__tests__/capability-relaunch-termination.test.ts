import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { disableCapability, removeCapabilityLoader } from "../launch-manager";
import { writeLaunchState } from "../launch-state";
import { useTempStateDir, withShimsAsync } from "./helpers";

const UDID = "RELAUNCH-TERMINATION-TEST-" + process.pid;
const BUNDLE_ID = "com.example.app";
const LAUNCH_ARGS = ["--flag", "space and $(literal)"];
const ABSENT_RESPONSE = [
  "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):",
  `Simulator device failed to terminate ${BUNDLE_ID}.`,
  "found nothing to terminate",
  "Underlying error (domain=NSPOSIXErrorDomain, code=3):",
  `The request to terminate "${BUNDLE_ID}" failed. found nothing to terminate`,
].join("\n");

describe("capability relaunch termination", () => {
  for (const fixture of [
    { name: "successful termination needs no running-state check", code: 0, stderr: "", running: false, check: false },
    { name: "the observed absent-app response needs no running-state check", code: 3, stderr: ABSENT_RESPONSE, running: false, check: false },
    { name: "an ambiguous exit 3 still checks whether the app stopped", code: 3, stderr: "terminate failed", running: false, check: true },
    { name: "matching words with a different exit code still need a check", code: 1, stderr: ABSENT_RESPONSE, running: false, check: true },
    { name: "a different error domain still needs a check", code: 3, stderr: ABSENT_RESPONSE.replaceAll("NSPOSIXErrorDomain", "OtherErrorDomain"), running: false, check: true },
    { name: "a different domain code still needs a check", code: 3, stderr: ABSENT_RESPONSE.replaceAll("code=3", "code=1"), running: false, check: true },
    { name: "domain code 30 still needs a check", code: 3, stderr: ABSENT_RESPONSE.replaceAll("code=3", "code=30"), running: false, check: true },
    { name: "domain code 31 still needs a check", code: 3, stderr: ABSENT_RESPONSE.replaceAll("code=3", "code=31"), running: false, check: true },
    { name: "POSIX code 3 alone still needs a check", code: 3, stderr: "domain=NSPOSIXErrorDomain, code=3", running: false, check: true },
    { name: "a failed termination cannot relaunch an app that is still running", code: 3, stderr: "terminate failed", running: true, check: true, error: "cannot be relaunched with its capabilities" },
    { name: "an unavailable running-state check prevents relaunch", code: 1, stderr: "could not reach simulator", running: null, check: true, error: "could not check whether it is still running" },
    { name: "a signaled command still needs a check despite matching diagnostic text", code: 3, stderr: ABSENT_RESPONSE, signal: true, running: false, check: true },
    { name: "a timed-out command with an unavailable check prevents relaunch", code: 3, stderr: ABSENT_RESPONSE, timeout: true, running: null, check: true, error: "could not check whether it is still running" },
  ]) {
    test(fixture.name, async () => {
      const state = useTempStateDir();
      const log = join(state.dir, "commands.jsonl");
      writeFileSync(log, "");
      writeLaunchState(UDID, {
        bundleId: BUNDLE_ID,
        launchArgs: LAUNCH_ARGS,
        capabilities: {
          probe: { name: "probe", dylib: "/probe.dylib", scope: "allApps", bundleId: BUNDLE_ID, ownerPid: null },
        },
      });
      try {
        await withShimsAsync({ xcrun: `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const fixture = ${JSON.stringify(fixture)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'simctl') process.exit(99);
if (args[1] === 'terminate') {
  process.stderr.write(fixture.stderr);
  if (fixture.timeout) setInterval(() => {}, 1000);
  else if (fixture.signal) process.kill(process.pid, 'SIGTERM');
  else process.exit(fixture.code);
} else if (args[1] === 'spawn' && args[3] === 'launchctl' && args[4] === 'list') {
  if (fixture.running === null) process.exit(1);
  if (fixture.running) console.log('42\\t0\\tUIKitApplication:${BUNDLE_ID}');
}
` }, async () => {
          try {
            // Removing a deferred capability reaches the real relaunchTarget path without a native build.
            const relaunch = disableCapability(UDID, null, "probe");
            if (fixture.error) await expect(relaunch).rejects.toThrow(fixture.error);
            else await relaunch;
            const calls = readFileSync(log, "utf8").trim().split("\n")
              .map((line) => JSON.parse(line) as string[])
              .filter((args) => args[1] === "terminate" || args[1] === "launch"
                || (args[1] === "spawn" && args[3] === "launchctl" && args[4] === "list"));
            expect(calls).toEqual([
              ["simctl", "terminate", UDID, BUNDLE_ID],
              ...(fixture.check ? [["simctl", "spawn", UDID, "launchctl", "list"]] : []),
              ...(fixture.error ? [] : [["simctl", "launch", UDID, BUNDLE_ID, ...LAUNCH_ARGS]]),
            ]);
          } finally {
            await removeCapabilityLoader(UDID);
          }
        });
      } finally {
        state.restore();
      }
    }, 20_000);
  }
});
