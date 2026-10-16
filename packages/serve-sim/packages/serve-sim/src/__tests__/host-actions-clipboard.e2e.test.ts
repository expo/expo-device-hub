import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runHostActionAsync } from "../host-actions";
import { closeDeviceSession, peekDeviceSession } from "../device-session";
import { axDescribeAsync } from "../native";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { useTempStateDir } from "./helpers";
import { COPY_FIXTURE_TEXT, FIXTURE_BUNDLE, ensureFixtureInstalled, launchWithoutReader, locatePasteboardFixtureApp } from "./pasteboard-sim";

const stateDir = useTempStateDir();
const udid = e2eDevice();
const ready = !!(udid && locatePasteboardFixtureApp());
requireE2E("clipboard host actions", ready);
let app: { unsubscribe(): void } | undefined;
afterAll(() => {
  if (udid) closeDeviceSession(udid);
  app?.unsubscribe();
  stateDir.restore();
});

(ready ? describe : describe.skip)("clipboard host actions on a Simulator", () => {
  beforeAll(async () => {
    closeDeviceSession(udid!);
    ensureFixtureInstalled(udid!);
    app = await launchWithoutReader(udid!, FIXTURE_BUNDLE);
  }, 60_000);

  test("copies without a viewer, writes and reads exact text, and pastes into the selected field", async () => {
    const run = async (action: string, params = {}) => {
      const result = await runHostActionAsync({ action, params: { udid, ...params } }, "false");
      console.log(`${action}: ${JSON.stringify(result)}`);
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout);
    };
    expect(peekDeviceSession(udid!)).toBeUndefined();
    expect((await run("clipboard.copy")).text).toBe(COPY_FIXTURE_TEXT);
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
  }, 60_000);
});
