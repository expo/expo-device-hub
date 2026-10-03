import { expect, test } from "bun:test";
import { existsSync, promises as fs, readFileSync } from "fs";
import { join } from "path";
import { clearLaunchState, releaseSessionSync } from "../launch-manager";
import { writeLaunchState } from "../launch-state";
import { readSimPasteboardResult } from "../sim-pasteboard-reader";
import { useTempStateDir, withShimsAsync } from "./helpers";

const BUNDLE = "dev.expo.App";
const UDID = `PASTEBOARD-RELAUNCH-${process.pid}`;

for (const scenario of ["switched", "replaced", "same", "initially-unknown"] as const) {
  test(`rechecks the clipboard target after publication (${scenario})`, async () => {
    const state = useTempStateDir();
    const previousSkip = process.env.SERVE_SIM_SKIP_PBPASTE;
    process.env.SERVE_SIM_SKIP_PBPASTE = "1";
    const container = join(state.dir, "container");
    const calls = join(state.dir, "calls");
    const grants = join(state.dir, "grants");
    const launched = join(state.dir, "launched");
    const relaunchExpected = scenario === "same" || scenario === "initially-unknown";
    const currentBundle = scenario === "switched" ? "dev.expo.Other" : BUNDLE;
    const currentPid = scenario === "replaced" ? 22 : 11;
    const shim = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");
const grants = ${JSON.stringify(grants)};
const count = existsSync(grants) ? Number(readFileSync(grants, "utf8")) : 0;
if (args[1] === "get_app_container") console.log(${JSON.stringify(container)});
else if (args[1] === "privacy") writeFileSync(grants, String(count + 1));
else if (args.includes("log") && args.includes("show")) {
  if (count >= 2 || ${scenario !== "initially-unknown"}) {
    const bundle = count >= 2 ? ${JSON.stringify(currentBundle)} : ${JSON.stringify(BUNDLE)};
    const pid = count >= 2 ? ${currentPid} : 11;
    console.log(JSON.stringify({ eventMessage: "[app<" + bundle + ">:" + pid + "] Setting process visibility to: Foreground" }));
  }
} else if (args[1] === "launch") writeFileSync(${JSON.stringify(launched)}, "launched");
`;
    try {
      writeLaunchState(UDID, { bundleId: BUNDLE, launchArgs: [], capabilities: {} });
      await withShimsAsync({ xcrun: shim }, async () => {
        const answer = relaunchExpected ? (async () => {
          const request = join(container, "tmp", "serve-sim-pasteboard.request");
          const done = join(container, "tmp", "serve-sim-pasteboard.txt.done");
          const deadline = Date.now() + 6000;
          while ((!existsSync(launched) || !existsSync(request)) && Date.now() < deadline) {
            await Bun.sleep(5);
          }
          expect(existsSync(launched)).toBe(true);
          const nonce = await fs.readFile(request, "utf8");
          await fs.rm(request);
          await fs.writeFile(`${done}.pending`, `${nonce}\nclipboard text`);
          await fs.rename(`${done}.pending`, done);
        })() : Promise.resolve();
        void answer.catch(() => {});
        try {
          if (relaunchExpected) {
            expect(await readSimPasteboardResult(UDID)).toEqual({ text: "clipboard text", relaunchedApp: BUNDLE });
          } else {
            await expect(readSimPasteboardResult(UDID)).rejects.toThrow("Open the app you copied from");
          }
          await answer;
          const commands = readFileSync(calls, "utf8");
          expect(commands.includes(`simctl terminate ${UDID} ${BUNDLE}`)).toBe(relaunchExpected);
          expect(commands.includes(`simctl launch ${UDID} ${BUNDLE}`)).toBe(relaunchExpected);
        } finally {
          await answer.catch(() => {});
          releaseSessionSync(UDID, process.pid, () => {});
        }
      });
    } finally {
      clearLaunchState(UDID);
      if (previousSkip === undefined) delete process.env.SERVE_SIM_SKIP_PBPASTE;
      else process.env.SERVE_SIM_SKIP_PBPASTE = previousSkip;
      state.restore();
    }
  }, 12_000);
}
