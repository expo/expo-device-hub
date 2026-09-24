import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { clearLaunchState, removeCapabilityLoaderSync } from "../launch-manager";
import { readSimPasteboard } from "../sim-pasteboard";
import {
  armClipboardForAllApps,
  askAppPasteboard,
  launchTrackedApp,
  ensureFixtureInstalled,
  firstBootedIosSim,
  FIXTURE_BUNDLE,
  isHeadlessPasteboard,
  mappedDylibCount,
  openAppForPasteboard,
  PASTEBOARD_TEST_APPS,
  pasteboardDylib,
  pasteboardFixture,
  pasteboardTool,
  runningPid,
  terminatePasteboardApps,
  withSkipPbpaste,
  writeTestPasteboard,
} from "./pasteboard-sim";
import { requireE2E } from "./e2e-preconditions";

const udid = firstBootedIosSim();
const injectReady = !!(udid && pasteboardTool && pasteboardDylib);
requireE2E("pasteboard injected reader E2E", injectReady);
const describeIfInject = injectReady ? describe : describe.skip;

describeIfInject(`injected pasteboard read (booted sim ${udid ?? "<skipped>"})`, () => {
  test.skipIf(!isHeadlessPasteboard())("simctl pbpaste fails without a GUI login session", () => {
    expect(() =>
      execFileSync("xcrun", ["simctl", "pbpaste", udid!], { stdio: "pipe" }),
    ).toThrow();
  });
});

for (const app of PASTEBOARD_TEST_APPS) {
  const run = "requireFixture" in app && !pasteboardFixture ? describe.skip : describeIfInject;
  run(`injected pasteboard read in ${app.label} (${udid ?? "<skipped>"})`, () => {
    let session: { unsubscribe: () => void; pid: number } | undefined;

    beforeAll(async () => {
      if (app.bundleId === FIXTURE_BUNDLE) ensureFixtureInstalled(udid!);
      session = await openAppForPasteboard(udid!, app.bundleId);
    }, 60_000);

    afterAll(() => {
      session?.unsubscribe();
    }, 60_000);

    // vmmap refuses to examine Safari, so this runs on our own app. The
    // answer assertions below prove the load either way; this one proves it
    // without trusting the protocol.
    test.skipIf(app.bundleId !== FIXTURE_BUNDLE)("the reader is mapped into the app", () => {
      expect(
        mappedDylibCount(udid!, session!.pid, "libSimPasteboardReader.dylib"),
      ).toBeGreaterThan(0);
    }, 20_000);

    test("the dylib answers a request in the app container", async () => {
      const probe = `serve-sim-protocol-probe-${app.label.replace(/\s+/g, "-")}`;
      writeTestPasteboard(udid!, probe);
      expect(await askAppPasteboard(udid!, app.bundleId)).toBe(probe);
    }, 15_000);

    test("readSimPasteboard returns writer text via pbpaste or inject", async () => {
      const probe = `serve-sim-product-read-${app.label.replace(/\s+/g, "-")}`;
      writeTestPasteboard(udid!, probe);
      expect(await readSimPasteboard(udid!)).toBe(probe);
    }, 20_000);

    test("reads unicode through the dylib when pbpaste is skipped", async () => {
      const probe = `café 🎉 email+tag@x.com 日本語 ${app.label}`;
      writeTestPasteboard(udid!, probe);
      expect(await withSkipPbpaste(() => readSimPasteboard(udid!))).toBe(probe);
    }, 20_000);
  });
}

const describeWildcard = udid && pasteboardTool && pasteboardDylib && pasteboardFixture
  ? describe
  : describe.skip;

describeWildcard(`clipboard armed for every app (${udid ?? "<skipped>"})`, () => {
  afterAll(() => {
    terminatePasteboardApps(udid!);
    clearLaunchState(udid!);
    removeCapabilityLoaderSync(udid!);
  }, 60_000);

  test("an app launched after arming answers without being relaunched", async () => {
    ensureFixtureInstalled(udid!);
    await armClipboardForAllApps(udid!);

    const session = await launchTrackedApp(udid!, FIXTURE_BUNDLE);
    const before = runningPid(udid!, FIXTURE_BUNDLE);
    expect(before).not.toBeNull();

    const probe = "serve-sim-wildcard-probe";
    writeTestPasteboard(udid!, probe);
    expect(await withSkipPbpaste(() => readSimPasteboard(udid!))).toBe(probe);

    expect(runningPid(udid!, FIXTURE_BUNDLE)).toBe(before);
    session.unsubscribe();
  }, 60_000);
});

describeIfInject(`injected pasteboard read with SpringBoard frontmost (${udid ?? "<skipped>"})`, () => {
  test("tells you to open the app you copied from", async () => {
    terminatePasteboardApps(udid!);
    await Bun.sleep(1000);
    await expect(withSkipPbpaste(() => readSimPasteboard(udid!))).rejects.toThrow(
      /Open the app you copied from/,
    );
  }, 20_000);
});
