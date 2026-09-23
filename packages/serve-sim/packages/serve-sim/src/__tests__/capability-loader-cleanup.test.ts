import { expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { removeCapabilityLoader } from "../launch-manager";
import { useTempStateDir, withShimsAsync } from "./helpers";

test("loader cleanup removes old and new names while preserving other inserts", async () => {
  const state = useTempStateDir();
  const log = join(state.dir, "commands");
  const previousLog = process.env.LOADER_TEST_LOG;
  process.env.LOADER_TEST_LOG = log;
  try {
    await withShimsAsync({ xcrun: `#!/bin/sh
if [ "$5" = "getenv" ]; then
  echo '/old/libServeSimTrampoline.dylib:/new/libServeSimCapabilityLoader.dylib:/other/mylibServeSimCapabilityLoader.dylib'
else
  echo "$*" >> "$LOADER_TEST_LOG"
fi
` }, async () => {
      await removeCapabilityLoader("TEST-DEVICE");
      const manager = join(import.meta.dir, "../launch-manager.ts");
      execFileSync(process.execPath, ["-e", `
        const { removeCapabilityLoaderSync } = await import(${JSON.stringify(manager)});
        removeCapabilityLoaderSync("TEST-DEVICE");
      `], { env: { ...process.env } });
    });
    const commands = readFileSync(log, "utf8").trim().split("\n");
    expect(commands.filter((line) => line.includes("setenv DYLD_INSERT_LIBRARIES"))).toEqual([
      "simctl spawn TEST-DEVICE launchctl setenv DYLD_INSERT_LIBRARIES /other/mylibServeSimCapabilityLoader.dylib",
      "simctl spawn TEST-DEVICE launchctl setenv DYLD_INSERT_LIBRARIES /other/mylibServeSimCapabilityLoader.dylib",
    ]);
  } finally {
    if (previousLog === undefined) delete process.env.LOADER_TEST_LOG;
    else process.env.LOADER_TEST_LOG = previousLog;
    state.restore();
  }
});
