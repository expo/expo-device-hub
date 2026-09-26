import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readCameraStatus } from "../camera-helper";
import { cameraCapability, shmNameForUdid } from "../camera-runtime";
import { clearLaunchState, armCapabilityLoader, isCapabilityEnabled, removeCapabilityLoaderSync } from "../launch-manager";
import { writeCameraFrame, closeCameraFrameStreams, claimCameraFrameStream } from "../camera-frames";
import { e2eDevice, readInsert, requireE2E } from "./e2e-preconditions";
import { useTempStateDir } from "./helpers";

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const FIXTURE = join(PKG_DIR, "dist/capability-loader/ServeSimLaunchFixture.app");
const HELPER = join(PKG_DIR, "dist/simcam/serve-sim-camera-helper");
const APP = "dev.expo.serve-sim.launch-fixture";
const SECOND_APP = "dev.expo.serve-sim.camera-second";
const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI) && existsSync(FIXTURE);
const scratch = mkdtempSync(join(tmpdir(), "serve-sim-camera-lifecycle-"));
// The loader env and the helper's shm name are still per simulator: pin a free device.
const stateDir = useTempStateDir();
requireE2E("camera lifecycle", ready);

function simctl(args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
}
function cli(args: string[]): string {
  // Bun's execFileSync ignores later process.env changes.
  return execFileSync("node", [CLI, "camera", ...args, "-d", udid!, "--quiet"], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: process.env,
  });
}
// get_app_container blocks for ~0.5s, and waitFor calls lines() twice per poll.
const containers = new Map<string, string>();
function lines(app: string, kind: string): string[] {
  let container = containers.get(app);
  if (!container) {
    container = simctl(["get_app_container", udid!, app, "data"]).trim();
    containers.set(app, container);
  }
  const path = join(container, "Documents/launches.tsv");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter((line) => line.startsWith(`${kind}\t`));
}
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(100);
  expect(check()).toBe(true);
}
function springboardPid(): string {
  const entry = simctl(["spawn", udid!, "launchctl", "list"]).split("\n")
    .find((line) => line.endsWith("\tcom.apple.SpringBoard"));
  const pid = entry?.split("\t")[0] ?? "";
  expect(pid).toMatch(/^\d+$/);
  return pid;
}
function image(name: string, red: number, blue: number, width = 4, height = 4): string {
  const rowBytes = Math.ceil(width * 3 / 4) * 4;
  const pixelBytes = rowBytes * height;
  const bmp = Buffer.alloc(54 + pixelBytes);
  bmp.write("BM"); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(width, 18); bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 54 + y * rowBytes + x * 3;
      bmp[i] = blue;
      bmp[i + 2] = red;
    }
  }
  const path = join(scratch, name); writeFileSync(path, bmp); return path;
}
const red = image("red.bmp", 255, 0);
const blue = image("blue.bmp", 0, 255);
const landscapeRed = image("landscape-red.bmp", 255, 0, 16, 9);

beforeAll(async () => {
  if (!ready) return;
  cli(["disable"]);
  removeCapabilityLoaderSync(udid!);
  clearLaunchState(udid!);
  const second = join(scratch, "Second.app");
  cpSync(FIXTURE, second, { recursive: true });
  execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", SECOND_APP, join(second, "Info.plist")]);
  execFileSync("codesign", ["--force", "--sign", "-", second], { stdio: "ignore" });
  for (const [app, bundle] of [[APP, FIXTURE], [SECOND_APP, second]]) {
    try { simctl(["uninstall", udid!, app!]); } catch {}
    simctl(["install", udid!, bundle!]);
  }
  await armCapabilityLoader(udid!);
}, 120_000);

afterAll(() => {
  try {
    if (ready) {
      try { cli(["disable"]); } finally { removeCapabilityLoaderSync(udid!); clearLaunchState(udid!); }
      for (const app of [APP, SECOND_APP]) {
        try { simctl(["uninstall", udid!, app]); } catch {}
      }
      expect(readInsert(udid!)).toBe("");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    stateDir.restore();
  }
}, 120_000);

describe.skipIf(!ready)("device-wide camera lifecycle", () => {
  test("enable from the home screen leaves SpringBoard and permissions alone", async () => {
    const pid = springboardPid();
    cli(["enable", "--file", red]);
    await Bun.sleep(1000);
    expect(springboardPid()).toBe(pid);
    expect(isCapabilityEnabled(udid!, "camera")).toBe(true);
    cli(["disable"]);
    expect(readInsert(udid!)).toContain("libServeSimCapabilityLoader.dylib");
  }, 30_000);

  test("two running apps disconnect and reconnect to a new image without relaunching", async () => {
    for (const app of [APP, SECOND_APP]) {
      simctl(["launch", udid!, app]);
      await waitFor(() => lines(app, "camera").some((line) => line.endsWith("no device")));
    }
    const starts = [APP, SECOND_APP].map((app) => lines(app, "start"));
    const permissions = [APP, SECOND_APP].map((app) => lines(app, "permission")[0]!.split("\t")[2]);
    const springboard = springboardPid();
    for (const [source, expected] of [[red, "255,0,0"], [blue, "0,0,255"], [red, "255,0,0"]]) {
      const before = [APP, SECOND_APP].map((app) => lines(app, "frame").length);
      cli(["enable", "--file", source!]);
      for (const [i, app] of [APP, SECOND_APP].entries()) {
        simctl(["launch", udid!, app]);
        await waitFor(() => lines(app, "frame").length > before[i]! && lines(app, "frame").at(-1)!.endsWith(expected!));
        expect(lines(app, "frame").at(-1)).toEndWith(expected!);
        expect(lines(app, "start")).toEqual(starts[i]!);
      }
      const disconnected = [APP, SECOND_APP].map((app) => lines(app, "disconnected").length);
      cli(["disable"]);
      for (const [i, app] of [APP, SECOND_APP].entries()) {
        simctl(["launch", udid!, app]);
        await waitFor(() => lines(app, "disconnected").length > disconnected[i]!);
        expect(lines(app, "disconnected").at(-1)).toEndWith(`connected=0 legacy=0 devices=0 permission=${permissions[i]}`);
        expect(lines(app, "start")).toEqual(starts[i]!);
        const samples = lines(app, "sample").length;
        await Bun.sleep(400);
        expect(lines(app, "sample").length).toBe(samples);
      }
      expect(springboardPid()).toBe(springboard);
      expect(readInsert(udid!)).toContain("libServeSimCapabilityLoader.dylib");
    }
  }, 180_000);
  test("a session started before the fake camera connects announces one start and one stop once it joins", async () => {
    try { simctl(["terminate", udid!, APP]); } catch {}
    cli(["disable"]);
    const started = lines(APP, "native-first-started").length;
    const before = lines(APP, "native-first").length;
    simctl(["launch", udid!, APP, "-ServeSimFixtureNativeFirst"]);
    await waitFor(() => lines(APP, "native-first-started").length > started);
    cli(["enable", "--file", red]);
    await waitFor(() => lines(APP, "native-first").length > before);
    expect(lines(APP, "native-first").at(-1)).toEndWith("via=connect starts=1 stops=1 kvo=2 running=0");
    cli(["disable"]);
  }, 60_000);
  test("an app leaves a helper that died unreaped and follows its replacement", async () => {
    try { simctl(["terminate", udid!, APP]); } catch {}
    const enabled = cli(["enable", "--file", red]).match(/helper pid: (\d+)|"helperPid":(\d+)/);
    expect(enabled).not.toBeNull();
    simctl(["launch", udid!, APP]);
    await waitFor(() => lines(APP, "frame").at(-1)?.endsWith("255,0,0") ?? false);
    const first = Number(enabled![1] ?? enabled![2]);
    process.kill(first, "SIGTERM");
    // A helper that exits after its replacement starts unlinks the replacement's shm name.
    await waitFor(() => { try { process.kill(first, 0); return false; } catch { return true; } });
    // sleep never reaps, so the helper it inherits stays a zombie after it dies.
    const parent = spawn("/bin/sh", [
      "-c", '"$0" --shm "$1" --socket "$2" --source image --arg "$3" >/dev/null 2>&1 & echo $!; exec sleep 120',
      HELPER, shmNameForUdid(udid!), join(scratch, "unreaped.sock"), blue,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let pid = 0;
    try {
      pid = Number(await new Promise<string>((resolve) => parent.stdout!.once("data", (d) => resolve(String(d).split("\n")[0]!))));
      await waitFor(() => lines(APP, "frame").at(-1)!.endsWith("0,0,255"));
      const disconnected = lines(APP, "disconnected").length;
      process.kill(pid, "SIGKILL");
      await waitFor(() => lines(APP, "disconnected").length > disconnected);
      cli(["enable", "--file", red]);
      await waitFor(() => lines(APP, "frame").at(-1)!.endsWith("255,0,0"));
    } finally {
      // SIGKILL, so a helper left running by a failed run cannot unlink another helper's shm.
      if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
      parent.kill();
      cli(["disable"]);
    }
  }, 90_000);
  test("an output added before the camera connects gets frames once the camera joins", async () => {
    try { simctl(["terminate", udid!, APP]); } catch {}
    cli(["disable"]);
    try {
      const started = lines(APP, "native-first-started").length;
      const frames = lines(APP, "frame").length;
      simctl(["launch", udid!, APP, "-ServeSimFixtureNativeFirst", "-ServeSimFixtureEarlyOutput"]);
      await waitFor(() => lines(APP, "native-first-started").length > started);
      cli(["enable", "--file", red]);
      await waitFor(() => lines(APP, "frame").length > frames && lines(APP, "frame").at(-1)!.endsWith("255,0,0"));
    } finally {
      cli(["disable"]);
    }
  }, 60_000);
  test("a preview layer moved off the camera session stops showing its frames", async () => {
    try { simctl(["terminate", udid!, APP]); } catch {}
    cli(["enable", "--file", red]);
    try {
      const before = lines(APP, "preview-contents").length;
      simctl(["launch", udid!, APP, "-ServeSimFixtureMovePreview"]);
      await waitFor(() => lines(APP, "preview-contents").length > before);
      expect(lines(APP, "preview-contents").at(-1)).toEndWith("\tnil");
    } finally {
      cli(["disable"]);
    }
  }, 60_000);
  test("samples queued before a session stops are not delivered after it", async () => {
    try { simctl(["terminate", udid!, APP]); } catch {}
    cli(["enable", "--file", red]);
    try {
      const before = lines(APP, "stop-drained").length;
      simctl(["launch", udid!, APP, "-ServeSimFixtureStopWithQueuedSamples"]);
      await waitFor(() => lines(APP, "stop-drained").length > before);
      expect(lines(APP, "stop-drained").at(-1)).toEndWith("\t0");
    } finally {
      cli(["disable"]);
    }
  }, 60_000);
  test("a session without an input does not get fake motion", async () => {
    try { simctl(["terminate", udid!, APP]); } catch {}
    cli(["enable", "--file", red]);
    try {
      const before = lines(APP, "motion-available").length;
      simctl(["launch", udid!, APP, "-ServeSimFixtureOutputOnly"]);
      await waitFor(() => lines(APP, "motion-available").length > before);
      expect(lines(APP, "motion-available").at(-1)).toEndWith("\tinjected=1 available=0");
    } finally {
      cli(["disable"]);
    }
  }, 60_000);
  test("a session enabling the camera without a source keeps the current feed", async () => {
    try {
      cli(["enable", "--file", red]);
      await cameraCapability.setEnabled({ udid: udid!, bundleId: null, options: {}, enabled: true });
      expect((await readCameraStatus(udid!)).source).toBe("image");
    } finally {
      cli(["disable"]);
    }
  }, 60_000);
  test("a session enabling the camera without a source after a failed switch keeps the restored feed", async () => {
    try {
      cli(["enable", "--file", red]);
      expect(() => cli(["switch", "webcam", "serve-sim-missing-camera"])).toThrow();
      expect((await readCameraStatus(udid!)).source).toBe("image");
      await cameraCapability.setEnabled({ udid: udid!, bundleId: null, options: {}, enabled: true });
      expect((await readCameraStatus(udid!)).source).toBe("image");
    } finally {
      cli(["disable"]);
    }
  }, 60_000);
  test("a legacy bundle-id argument enables the camera", () => {
    try {
      cli(["dev.example.legacy", "--file", red]);
      expect(isCapabilityEnabled(udid!, "camera")).toBe(true);
    } finally {
      cli(["disable"]);
    }
  }, 60_000);
  test("an unknown word or a bare file name does not enable the camera", () => {
    cli(["disable"]);
    expect(() => cli(["enabel", "--file", red])).toThrow();
    expect(() => cli(["red.png"])).toThrow();
    expect(isCapabilityEnabled(udid!, "camera")).toBe(false);
  }, 60_000);
  test("the preview fits the frame the way the app's videoGravity asks", async () => {
    try { simctl(["terminate", udid!, APP]); } catch {}
    cli(["enable", "--file", red]);
    try {
      const before = lines(APP, "gravity").length;
      const pixels = lines(APP, "preview-pixels").length;
      simctl(["launch", udid!, APP, "-ServeSimFixtureGravityAspect"]);
      await waitFor(() => lines(APP, "gravity").length > before);
      expect(lines(APP, "gravity").at(-1)).toEndWith("\tresizeAspect");
      // The frame is wider than the portrait layer, so an aspect fit leaves the top empty.
      await waitFor(() => lines(APP, "preview-pixels").length > pixels);
      expect(lines(APP, "preview-pixels").at(-1)).toEndWith("\tcenter=255,0,0,255 top=0,0,0,0");
    } finally {
      cli(["disable"]);
    }
  }, 60_000);
  test("the preview follows a videoGravity change after the camera connects", async () => {
    try { simctl(["terminate", udid!, APP]); } catch {}
    cli(["enable", "--file", red]);
    try {
      const before = lines(APP, "gravity").length;
      simctl(["launch", udid!, APP, "-ServeSimFixtureGravityChange"]);
      await waitFor(() => lines(APP, "gravity").length > before + 1);
      expect(lines(APP, "gravity").at(-1)).toEndWith("\tresize");
    } finally {
      cli(["disable"]);
    }
  }, 60_000);
  test("landscape image arrives in a portrait frame with opaque black padding", async () => {
    try { simctl(["terminate", udid!, APP]); } catch {}
    cli(["enable", "--file", landscapeRed]);
    try {
      const before = lines(APP, "fit").length;
      simctl(["launch", udid!, APP, "-ServeSimFixtureLandscapeFit"]);
      await waitFor(() => lines(APP, "fit").length > before);
      expect(lines(APP, "size").at(-1)).toEndWith("\t720x1280");
      expect(lines(APP, "frame").at(-1)).toEndWith("\t255,0,0");
      expect(lines(APP, "edge").at(-1)).toEndWith("\t0,0,0,255");
      expect(lines(APP, "fit").at(-1)).toEndWith("\t0,0,0,255|255,0,0,255");
    } finally {
      cli(["disable"]);
    }
  }, 60_000);
  test("queued cached frames do not arrive after disconnect", async () => {
    try { simctl(["terminate", udid!, APP]); } catch {}
    cli(["enable", "--file", red]);
    const suspended = lines(APP, "queue-suspended").length;
    const drained = lines(APP, "queue-drained").length;
    const samples = lines(APP, "queued-sample").length;
    simctl(["launch", udid!, APP, "-ServeSimFixtureQueuedFrames"]);
    await waitFor(() => lines(APP, "queue-suspended").length > suspended);
    cli(["disable"]);
    await waitFor(() => lines(APP, "queue-drained").length > drained);
    expect(lines(APP, "queued-sample").length).toBe(samples);
  }, 60_000);
  test("a photo is delivered while connected and reports a disconnect after disable", async () => {
    try { simctl(["terminate", udid!, APP]); } catch {}
    cli(["enable", "--file", red]);
    const before = lines(APP, "photo").length;
    const steps = () => lines(APP, "photo").slice(before).map((line) => line.split("\t")[2]);
    try {
      simctl(["launch", udid!, APP, "-ServeSimFixturePhoto"]);
      await waitFor(() => steps().length >= 3);
      const [captured, processed, finished] = steps();
      expect([captured, finished]).toEqual(["captured", "finished error=0"]);
      expect(processed).toMatch(/^processed \d+x\d+$/);
      expect(processed).not.toBe("processed 1x1");
    } finally {
      cli(["disable"]);
    }
    await waitFor(() => steps().length >= 6);
    expect(steps().slice(3)).toEqual(["captured", "processed error=-11808", "finished error=-11808"]);
  }, 60_000);

  test("browser frame transport disconnects and reconnects the running app", async () => {
    cli(["disable"]);
    simctl(["launch", udid!, APP]);
    const starts = lines(APP, "start");
    for (const [source, expected] of [[red, "255,0,0"], [blue, "0,0,255"]]) {
      cli(["enable", "--stream"]);
      expect((await readCameraStatus(udid!)).connected).toBe(false);
      const owner = Symbol("browser-frame-test");
      claimCameraFrameStream(udid!, owner);
      const before = lines(APP, "frame").length;
      const frame = readFileSync(source!);
      const timer = setInterval(() => writeCameraFrame(udid!, frame, owner), 50);
      let disconnected = lines(APP, "disconnected").length;
      try {
        await waitFor(() => lines(APP, "frame").length > before && lines(APP, "frame").at(-1)!.endsWith(expected!));
        disconnected = lines(APP, "disconnected").length;
      } finally {
        clearInterval(timer);
        closeCameraFrameStreams(owner);
      }
      await waitFor(() => lines(APP, "disconnected").length > disconnected);
      expect((await readCameraStatus(udid!)).connected).toBe(false);
      expect(lines(APP, "start")).toEqual(starts);
    }
    cli(["disable"]);
  }, 60_000);

});
