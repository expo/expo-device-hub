import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { foregroundTracker, frontmostAppFromRecentLogs } from "../foreground-tracker";
import { clearLaunchState, removeCapabilityLoaderSync } from "../launch-manager";
import { simctlSync } from "../simctl";
import { readSimPasteboard } from "../sim-pasteboard-reader";
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
  SAFARI_BUNDLE,
  pasteboardDylib,
  pasteboardFixture,
  pasteboardTool,
  runningPid,
  terminatePasteboardApps,
  withSkipPbpaste,
  writeTestPasteboard,
} from "./pasteboard-sim";
import { requireE2E } from "./e2e-preconditions";
import { useTempStateDir } from "./helpers";

const stateDir = useTempStateDir();
afterAll(() => stateDir.restore());

const udid = firstBootedIosSim();
const injectReady = !!(udid && pasteboardTool && pasteboardDylib);
requireE2E("pasteboard injected reader E2E", injectReady);
requireE2E("pasteboard injected reader fixture E2E", !!(injectReady && pasteboardFixture));
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

describeWildcard(`clipboard from an untracked app (${udid ?? "<skipped>"})`, () => {
  afterAll(() => {
    terminatePasteboardApps(udid!);
    clearLaunchState(udid!);
    removeCapabilityLoaderSync(udid!);
  }, 60_000);

  test("finds a simctl-launched app without a foreground subscriber", async () => {
    ensureFixtureInstalled(udid!);
    clearLaunchState(udid!);
    removeCapabilityLoaderSync(udid!);
    simctlSync(["launch", udid!, FIXTURE_BUNDLE]);
    expect(foregroundTracker.peek(udid!)).toBeNull();

    const probe = "serve-sim-untracked-app-probe";
    writeTestPasteboard(udid!, probe);
    expect(await withSkipPbpaste(() => readSimPasteboard(udid!))).toBe(probe);
  }, 60_000);
});

describeWildcard(`clipboard read while switching apps (${udid ?? "<skipped>"})`, () => {
  afterAll(() => {
    terminatePasteboardApps(udid!);
    clearLaunchState(udid!);
    removeCapabilityLoaderSync(udid!);
  }, 60_000);

  test("does not relaunch the old app over the new foreground app", async () => {
    ensureFixtureInstalled(udid!);
    clearLaunchState(udid!);
    removeCapabilityLoaderSync(udid!);
    const session = await launchTrackedApp(udid!, FIXTURE_BUNDLE);
    try {
      const pid = runningPid(udid!, FIXTURE_BUNDLE);
      const container = simctlSync(["get_app_container", udid!, FIXTURE_BUNDLE, "data"]);
      const request = join(container, "tmp", "serve-sim-pasteboard.request");
      const reading = withSkipPbpaste(() => readSimPasteboard(udid!));
      const deadline = Date.now() + 20_000;
      while (!existsSync(request) && Date.now() < deadline) await Bun.sleep(25);
      expect(existsSync(request)).toBe(true);
      simctlSync(["launch", udid!, SAFARI_BUNDLE]);

      await expect(reading).rejects.toThrow(/Open the app you copied from/);
      expect(runningPid(udid!, FIXTURE_BUNDLE)).toBe(pid);
      expect((await frontmostAppFromRecentLogs(udid!))?.bundleId).toBe(SAFARI_BUNDLE);
    } finally {
      session.unsubscribe();
      terminatePasteboardApps(udid!);
      clearLaunchState(udid!);
      removeCapabilityLoaderSync(udid!);
    }
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
