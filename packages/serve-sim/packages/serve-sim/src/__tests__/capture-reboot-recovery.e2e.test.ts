import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { freePortAsync, killHelpersForDevice, useTempStateDir } from "./helpers";

const CLI = join(import.meta.dir, "../..", "dist/serve-sim.js");
const FIXTURE = join(import.meta.dir, "../..", "dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";

const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI) && existsSync(FIXTURE);
requireE2E("capture recovery after a device reboot", ready);

const describeOrSkip = ready ? describe : describe.skip;

type CaptureCounts = { screenFrames: number; idleFrames: number; surfaceLosses?: number };

async function waitForAsync<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(250);
  }
  return undefined;
}

async function readJpeg(response: Response): Promise<Uint8Array> {
  const reader = response.body!.getReader();
  let data = new Uint8Array(0);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the stream ended before a whole frame");
      const next = new Uint8Array(data.length + value.length);
      next.set(data);
      next.set(value, data.length);
      data = next;
      const start = data.findIndex((byte, i) => byte === 0xff && data[i + 1] === 0xd8);
      if (start < 0) continue;
      for (let i = start + 2; i + 1 < data.length; i++) {
        if (data[i] === 0xff && data[i + 1] === 0xd9) return data.slice(start, i + 2);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function centerPixel(jpeg: Uint8Array): [number, number, number] {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-frame-"));
  try {
    writeFileSync(join(dir, "frame.jpg"), jpeg);
    execFileSync("sips", ["-s", "format", "bmp", join(dir, "frame.jpg"), "--out", join(dir, "frame.bmp")], { stdio: "ignore" });
    const bmp = readFileSync(join(dir, "frame.bmp"));
    const offset = bmp.readUInt32LE(10), width = bmp.readInt32LE(18), height = Math.abs(bmp.readInt32LE(22));
    const bytesPerPixel = bmp.readUInt16LE(28) / 8;
    const rowBytes = Math.ceil((width * bytesPerPixel) / 4) * 4;
    const at = offset + Math.floor(height / 2) * rowBytes + Math.floor(width / 2) * bytesPerPixel;
    return [bmp[at + 2]!, bmp[at + 1]!, bmp[at]!];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// systemGreenColor is about (52, 199, 89); the default wallpaper's center is a light teal.
const isGreen = ([r, g, b]: [number, number, number]) => r < 110 && g > 160 && b < 140;

function simctl(...args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 180_000 });
}

describeOrSkip("capture recovery after a device reboot", () => {
  let tempState: ReturnType<typeof useTempStateDir>;
  let server: ChildProcess | undefined;
  let output = "";
  let stats = async (): Promise<CaptureCounts> => ({ screenFrames: 0, idleFrames: 0 });
  let frame = async (): Promise<Uint8Array> => new Uint8Array(0);
  const frames = (c: CaptureCounts) => c.screenFrames + c.idleFrames;

  beforeAll(async () => {
    tempState = useTempStateDir();
    killHelpersForDevice(udid!);
    const port = await freePortAsync();
    const base = `http://127.0.0.1:${port}`;
    server = spawn("node", [CLI, "--require-token", "--quiet", "--port", String(port), udid!], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    for (const stream of [server.stdout, server.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
    }
    await waitForAsync(async () => ((await fetch(`${base}/readyz`)).ok ? true : undefined), 90_000);
    const stateFile = join(tempState.dir, `server-${udid!}.json`);
    const { token } = JSON.parse(readFileSync(stateFile, "utf-8")) as { token: string };
    stats = async () => {
      const response = await fetch(`${base}/helper/${udid}/webrtc/stats`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`stats ${response.status}`);
      return ((await response.json()) as { capture: CaptureCounts }).capture;
    };
    frame = async () => {
      const response = await fetch(`${base}/helper/${udid}/stream.mjpeg`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`stream ${response.status}`);
      return await readJpeg(response);
    };
  }, 120_000);

  afterAll(async () => {
    if (server?.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          server?.kill("SIGKILL");
          done();
        }, 30_000);
        server!.on("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    tempState?.restore();
    try { simctl("uninstall", udid!, APP); } catch {}
    // Keep later suites booted if the test failed during reboot.
    if (!simctl("list", "devices", "booted").includes(udid!)) {
      simctl("boot", udid!);
      simctl("bootstatus", udid!, "-b");
    }
  }, 240_000);

  test("captures again after the device reboots", async () => {
    // Reject cached green frames from an earlier run.
    try { simctl("uninstall", udid!, APP); } catch {}
    let pixel: [number, number, number] | undefined;
    const notGreen = await waitForAsync(async () => {
      pixel = centerPixel(await frame());
      return isGreen(pixel) ? undefined : pixel;
    }, 20_000);
    expect(notGreen, `the stream is green before the reboot; last center pixel ${pixel}`).toBeDefined();

    const before = await waitForAsync(async () => {
      const c = await stats();
      return frames(c) > 10 ? c : undefined;
    }, 30_000);
    expect(before, output).toBeDefined();

    simctl("shutdown", udid!);
    simctl("boot", udid!);
    simctl("bootstatus", udid!, "-b");
    const booted = await waitForAsync(stats, 10_000);
    expect(booted, output).toBeDefined();

    const resumed = await waitForAsync(async () => {
      const c = await stats();
      return frames(c) >= frames(booted!) + 10 ? c : undefined;
    }, 30_000);
    expect(resumed, `no frames after the reboot; output:\n${output}`).toBeDefined();
    expect(resumed!.surfaceLosses).toBeGreaterThanOrEqual(1);
    expect(output).toContain("re-wiring the display pipeline");

    // Verify new pixels reach the stream after reboot.
    simctl("install", udid!, FIXTURE);
    simctl("launch", udid!, APP);
    const green = await waitForAsync(async () => {
      pixel = centerPixel(await frame());
      return isGreen(pixel) ? pixel : undefined;
    }, 20_000);
    expect(green, `the stream did not show the fixture; last center pixel ${pixel}; output:\n${output}`).toBeDefined();
  }, 300_000);
});
