import { afterAll, describe, expect, test } from "bun:test";
import { runHostActionAsync } from "../host-actions";
import { closeDeviceSession, peekDeviceSession } from "../device-session";
import { clearLaunchState, removeCapabilityLoaderSync } from "../launch-manager";
import { axDescribeAsync, locateNativeAddon } from "../native";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { useTempStateDir } from "./helpers";
import {
  COPY_FIXTURE_TEXT,
  FIXTURE_BUNDLE,
  ensureFixtureInstalled,
  killSimApp,
  launchWithoutReader,
  openAppForPasteboard,
  pasteboardDylib,
  pasteboardFixture,
  pasteboardTool,
  withSkipPbpaste,
} from "./pasteboard-sim";

const stateDir = useTempStateDir();
const udid = e2eDevice();
const ready = !!(
  udid &&
  pasteboardFixture &&
  pasteboardTool &&
  pasteboardDylib &&
  locateNativeAddon()
);
requireE2E("clipboard host actions", ready);
afterAll(() => stateDir.restore());

(ready ? describe : describe.skip)("clipboard host actions on a Simulator", () => {
  const run = async (action: string, params = {}) => {
    const result = await runHostActionAsync({ action, params: { udid, ...params } }, "false");
    console.log(`${action}: ${JSON.stringify(result)}`);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout);
  };

  test("copies without a viewer or an app reader", async () => {
    closeDeviceSession(udid!);
    let app: { unsubscribe(): void } | undefined;
    try {
      ensureFixtureInstalled(udid!);
      app = await launchWithoutReader(udid!, FIXTURE_BUNDLE);
      expect(peekDeviceSession(udid!)).toBeUndefined();
      expect((await run("clipboard.copy")).text).toBe(COPY_FIXTURE_TEXT);
    } finally {
      closeDeviceSession(udid!);
      app?.unsubscribe();
      killSimApp(udid!, FIXTURE_BUNDLE);
      clearLaunchState(udid!);
      removeCapabilityLoaderSync(udid!);
    }
  }, 60_000);

  test("writes, reads and pastes through the headless app reader", async () => {
    closeDeviceSession(udid!);
    let app: { unsubscribe(): void } | undefined;
    try {
      ensureFixtureInstalled(udid!);
      app = await openAppForPasteboard(udid!, FIXTURE_BUNDLE);
      expect(peekDeviceSession(udid!)).toBeUndefined();
      await withSkipPbpaste(async () => {
        const text = ' \n🦆 {"text":true}\n ';
        await run("clipboard.write", { text });
        expect((await run("clipboard.read")).text).toBe(text);
        await run("clipboard.paste");
        await run("clipboard.paste", { text: "direct paste" });
        const pastedText = JSON.stringify(`${text}direct paste`).slice(1, -1);
        const deadline = Date.now() + 5000;
        let tree = "";
        do {
          tree = await axDescribeAsync(udid!);
          if (tree.includes(pastedText)) break;
          await Bun.sleep(100);
        } while (Date.now() < deadline);
        expect(tree).toContain(pastedText);
        await run("clipboard.write", { text: "" });
        expect((await run("clipboard.read")).text).toBe("");
      });
    } finally {
      closeDeviceSession(udid!);
      app?.unsubscribe();
    }
  }, 60_000);
});
