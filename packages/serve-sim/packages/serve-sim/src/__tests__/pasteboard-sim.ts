import { execFileSync } from "child_process";
import { simctlSync } from "../simctl";
import { existsSync } from "fs";
import { join } from "path";
import { simCopyHidEvents, simSelectAllHidEvents, type HidKeyEvent } from "../client/utils/sim-clipboard";
import { foregroundTracker } from "../foreground-tracker";
import {
  clearLaunchState,
  enableCapabilities,
  removeCapabilityLoader,
  removeCapabilityLoaderSync,
} from "../launch-manager";
import {
  CLIPBOARD_CAPABILITY,
  locateSimpbArtifact,
  locatePasteboardReaderDylib,
  locatePasteboardTool,
  requestInjectedPasteboard,
} from "../sim-pasteboard";
import { dirnameOf } from "../runtime";

export const SAFARI_BUNDLE = "com.apple.mobilesafari";
export const FIXTURE_BUNDLE = "dev.expo.serve-sim.pasteboard-fixture";
export const COPY_FIXTURE_TEXT = "serve-sim-copy-probe";
export const PASTEBOARD_TEST_APPS = [
  { label: "Safari", bundleId: SAFARI_BUNDLE },
  { label: "user app", bundleId: FIXTURE_BUNDLE, requireFixture: true },
] as const;

const __dirname = dirnameOf(import.meta.url);

export function firstBootedIosSim(): string | null {
  const pinned = process.env.SERVE_SIM_TEST_UDID?.trim();
  try {
    const out = simctlSync(["list", "devices", "booted", "-j"]);
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    const booted: string[] = [];
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!runtime.includes("iOS")) continue;
      for (const device of devices) {
        if (device.state === "Booted") booted.push(device.udid);
      }
    }
    if (pinned) return booted.includes(pinned) ? pinned : null;
    return booted[0] ?? null;
  } catch {}
  return null;
}

export function isHeadlessPasteboard(): boolean {
  const udid = firstBootedIosSim();
  if (!udid) return false;
  try {
    simctlSync(["pbpaste", udid], { timeout: 5000 });
    return false;
  } catch {
    return true;
  }
}

export async function withSkipPbpaste<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.SERVE_SIM_SKIP_PBPASTE;
  process.env.SERVE_SIM_SKIP_PBPASTE = "1";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.SERVE_SIM_SKIP_PBPASTE;
    else process.env.SERVE_SIM_SKIP_PBPASTE = previous;
  }
}

export function writeTestPasteboard(
  udid: string,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const tool = locatePasteboardTool();
  if (!tool) throw new Error("serve-sim-pasteboard is missing; run build.ts");
  execFileSync("xcrun", ["simctl", "spawn", udid, tool], {
    input: text,
    env,
    stdio: ["pipe", "ignore", "pipe"],
  });
}

export function runningPid(udid: string, bundleId: string): number | null {
  const out = simctlSync(["spawn", udid, "launchctl", "list"], { maxBuffer: 8 * 1024 * 1024 });
  const line = out.split("\n").find((row) => row.includes(bundleId));
  const pid = line ? Number(line.split("\t")[0]) : NaN;
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * Arm the reader for every app the way a session start does, with no target
 * app, so nothing is relaunched.
 */
export async function armClipboardForAllApps(udid: string): Promise<void> {
  const dylib = locatePasteboardReaderDylib();
  if (!dylib) throw new Error("libSimPasteboardReader.dylib is missing; run build.ts");
  await enableCapabilities(udid, null, [
    {
      name: CLIPBOARD_CAPABILITY,
      dylib,
      scope: "allApps",
      loadDelayMs: 0,
    },
  ], { relaunch: false });
}

export function mappedDylibCount(udid: string, pid: number, name: string): number {
  const out = simctlSync(["spawn", udid, "vmmap", String(pid)], { maxBuffer: 32 * 1024 * 1024 });
  return out.split("\n").filter((line) => line.includes(name)).length;
}

export function locatePasteboardFixtureApp(): string | null {
  const app = locateSimpbArtifact("PasteboardFixture.app");
  return app && existsSync(join(app, "PasteboardFixture")) ? app : null;
}

/** `simctl terminate` exits non-zero when the app is not running. */
export function killSimApp(udid: string, bundleId: string): void {
  try {
    simctlSync(["terminate", udid, bundleId], { timeout: 15_000 });
  } catch {}
}

export function terminatePasteboardApps(udid: string): void {
  killSimApp(udid, SAFARI_BUNDLE);
  killSimApp(udid, FIXTURE_BUNDLE);
  simctlSync(["launch", udid, "com.apple.springboard"], { timeout: 8_000 });
}

function grantPasteboard(udid: string, bundleId: string): void {
  try {
    simctlSync(["privacy", udid, "grant", "pasteboard", bundleId], { timeout: 8_000 });
  } catch {}
}

export function ensureFixtureInstalled(udid: string): string {
  const app = locatePasteboardFixtureApp();
  if (!app) throw new Error("PasteboardFixture.app is missing; build Sources/SimPasteboardFixture");
  killSimApp(udid, FIXTURE_BUNDLE);
  simctlSync(["install", udid, app], { timeout: 30_000 });
  grantPasteboard(udid, FIXTURE_BUNDLE);
  return FIXTURE_BUNDLE;
}

async function waitForLaunch(udid: string, bundleId: string, pid: number | null): Promise<number> {
  if (pid == null) throw new Error(`${bundleId} did not report a pid when it launched`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const peek = foregroundTracker.peek(udid);
    if (peek?.bundleId === bundleId && peek.pid === pid) {
      await Bun.sleep(700);
      return pid;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `${bundleId} launched (pid ${pid}) but the foreground tracker never saw it (peek=${JSON.stringify(foregroundTracker.peek(udid))})`,
  );
}

function launchedPid(output: string): number | null {
  const match = /:\s*(\d+)/.exec(output);
  return match ? parseInt(match[1]!, 10) : null;
}

function simctlLaunch(udid: string, bundleId: string): number | null {
  return launchedPid(
    simctlSync(["launch", udid, bundleId], { timeout: 12_000 }),
  );
}

async function resetLaunchState(udid: string, bundleId: string): Promise<void> {
  killSimApp(udid, bundleId);
  clearLaunchState(udid);
  await removeCapabilityLoader(udid);
}

/**
 * Launch with the clipboard capability off, so a Copy has to enable it. This is
 * the shape of a real session where the user opened the app themselves.
 */
export async function launchWithoutReader(
  udid: string,
  bundleId: string,
): Promise<{ unsubscribe: () => void }> {
  const subscription = foregroundTracker.subscribe(udid);
  await resetLaunchState(udid, bundleId);
  return finishLaunch(udid, bundleId, subscription);
}

export async function launchTrackedApp(
  udid: string,
  bundleId: string,
): Promise<{ unsubscribe: () => void }> {
  const subscription = foregroundTracker.subscribe(udid);
  killSimApp(udid, bundleId);
  return finishLaunch(udid, bundleId, subscription);
}

async function finishLaunch(
  udid: string,
  bundleId: string,
  subscription: { unsubscribe: () => void },
): Promise<{ unsubscribe: () => void }> {
  grantPasteboard(udid, bundleId);
  try {
    await waitForLaunch(udid, bundleId, simctlLaunch(udid, bundleId));
  } catch (error: unknown) {
    subscription.unsubscribe();
    throw error;
  }
  return subscription;
}

/**
 * Open `bundleId` with the clipboard capability already loaded, the way a
 * session that launched the app through the manager would have it.
 */
export async function openAppForPasteboard(
  udid: string,
  bundleId: string,
): Promise<{ unsubscribe: () => void; pid: number }> {
  const dylib = locatePasteboardReaderDylib();
  if (!dylib) throw new Error("libSimPasteboardReader.dylib is missing; run build.ts");
  const subscription = foregroundTracker.subscribe(udid);

  const cleanup = () => {
    subscription.unsubscribe();
    killSimApp(udid, bundleId);
    clearLaunchState(udid);
    removeCapabilityLoaderSync(udid);
  };

  try {
    await resetLaunchState(udid, bundleId);
    grantPasteboard(udid, bundleId);
    await enableCapabilities(udid, bundleId, [{
      name: CLIPBOARD_CAPABILITY,
      dylib,
      scope: "allApps",
      loadDelayMs: 0,
    }]);
    const pid = runningPid(udid, bundleId);
    return { unsubscribe: cleanup, pid: await waitForLaunch(udid, bundleId, pid) };
  } catch (error: unknown) {
    cleanup();
    throw error;
  }
}

export async function askAppPasteboard(udid: string, bundleId: string): Promise<string | null> {
  const container = simctlSync(["get_app_container", udid, bundleId, "data"]).trim();
  if (!container) return null;
  return requestInjectedPasteboard(container, 8000);
}

export function nativeAddonExists(): boolean {
  const candidates = [
    join(__dirname, "..", "..", "dist", "native", "serve-sim-native.node"),
    join(__dirname, "..", "native", "serve-sim-native.node"),
  ];
  return candidates.some((candidate) => existsSync(candidate));
}

async function sendHidEvents(udid: string, events: HidKeyEvent[]): Promise<void> {
  const { NativeHid } = await import("../native");
  const hid = new NativeHid(udid);
  for (const ev of events) {
    if (ev.type === "up") await Bun.sleep(30);
    await hid.key(ev.type, ev.usage);
  }
}

export async function sendSimCopyShortcut(udid: string): Promise<void> {
  await sendHidEvents(udid, simCopyHidEvents(new Set()));
  await Bun.sleep(150);
}

export async function sendSimSelectAllShortcut(udid: string): Promise<void> {
  await sendHidEvents(udid, simSelectAllHidEvents(new Set()));
  await Bun.sleep(150);
}

export const pasteboardTool = locatePasteboardTool();
export const pasteboardDylib = locatePasteboardReaderDylib();
export const pasteboardFixture = locatePasteboardFixtureApp();
