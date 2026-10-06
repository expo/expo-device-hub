import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { foregroundTracker } from "../foreground-tracker";
import { clearLaunchState, removeCapabilityLoaderSync } from "../launch-manager";
import { simctlSync } from "../simctl";
import { readSimPasteboardResult } from "../sim-pasteboard-reader";
import {
  armClipboardForAllApps,
  askAppPasteboard,
  launchTrackedApp,
  ensureFixtureInstalled,
  FIXTURE_BUNDLE,
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
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { useTempStateDir } from "./helpers";

const stateDir = useTempStateDir();
afterAll(() => stateDir.restore());

const udid = e2eDevice();
const injectReady = !!(udid && pasteboardTool && pasteboardDylib);
requireE2E("pasteboard injected reader E2E", injectReady);
requireE2E("pasteboard injected reader fixture E2E", !!(injectReady && pasteboardFixture));
const describeIfInject = injectReady ? describe : describe.skip;

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

    test("readSimPasteboardResult returns writer text via pbpaste or inject", async () => {
      const probe = `serve-sim-product-read-${app.label.replace(/\s+/g, "-")}`;
      writeTestPasteboard(udid!, probe);
      expect((await readSimPasteboardResult(udid!)).text).toBe(probe);
    }, 20_000);

    test("reads unicode through the dylib when pbpaste is skipped", async () => {
      const probe = `café 🎉 email+tag@x.com 日本語 ${app.label}`;
      writeTestPasteboard(udid!, probe);
      expect((await withSkipPbpaste(() => readSimPasteboardResult(udid!))).text).toBe(probe);
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
    expect((await withSkipPbpaste(() => readSimPasteboardResult(udid!))).text).toBe(probe);

    expect(runningPid(udid!, FIXTURE_BUNDLE)).toBe(before);
    session.unsubscribe();
  }, 60_000);
});

describeWildcard(`clipboard from an untracked app (${udid ?? "<skipped>"})`, () => {
  afterAll(() => {
    terminatePasteboardApps(udid!);
    clearLaunchState(udid!);
    removeCapabilityLoaderSync(udid!);
  }, 60_000);

  test("an app started before arming requires an explicit restart", async () => {
    ensureFixtureInstalled(udid!);
    clearLaunchState(udid!);
    removeCapabilityLoaderSync(udid!);
    simctlSync(["launch", udid!, FIXTURE_BUNDLE]);
    const pid = runningPid(udid!, FIXTURE_BUNDLE);
    expect(pid).not.toBeNull();
    expect(foregroundTracker.peek(udid!)).toBeNull();
    await armClipboardForAllApps(udid!);

    await expect(withSkipPbpaste(() => readSimPasteboardResult(udid!))).rejects.toThrow(
      /Restart the app and retry/,
    );
    expect(runningPid(udid!, FIXTURE_BUNDLE)).toBe(pid);

    simctlSync(["terminate", udid!, FIXTURE_BUNDLE]);
    simctlSync(["launch", udid!, FIXTURE_BUNDLE]);
    expect(runningPid(udid!, FIXTURE_BUNDLE)).not.toBe(pid);
    const probe = "serve-sim-untracked-app-probe";
    writeTestPasteboard(udid!, probe);
    expect((await withSkipPbpaste(() => readSimPasteboardResult(udid!))).text).toBe(probe);
  }, 60_000);
});

describeIfInject(`injected pasteboard read with SpringBoard frontmost (${udid ?? "<skipped>"})`, () => {
  afterAll(() => {
    clearLaunchState(udid!);
    removeCapabilityLoaderSync(udid!);
  });

  test("tells you to open an app without restarting SpringBoard", async () => {
    await armClipboardForAllApps(udid!);
    terminatePasteboardApps(udid!);
    const pid = runningPid(udid!, "com.apple.SpringBoard");
    expect(pid).not.toBeNull();
    await Bun.sleep(1000);
    await expect(withSkipPbpaste(() => readSimPasteboardResult(udid!))).rejects.toThrow(
      /Open the app you copied from/,
    );
    expect(runningPid(udid!, "com.apple.SpringBoard")).toBe(pid);
  }, 20_000);
});
