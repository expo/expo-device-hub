import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import WebSocket from "ws";
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";
import { NativeCapture } from "../native";
import { summarizeMp4 } from "./mp4-helpers";

import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { freePortAsync, killHelpersForDevice, useTempStateDir } from "./helpers";

const CLI = process.env.SERVE_SIM_RECOVERY_CLI ?? join(import.meta.dir, "../..", "dist/serve-sim.js");
const FIXTURE = join(import.meta.dir, "../..", "dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";

const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI) && existsSync(FIXTURE);
requireE2E("capture recovery after a device reboot", ready);

const describeOrSkip = ready ? describe : describe.skip;

type CaptureCounts = { screenFrames: number; idleFrames: number; surfaceLosses?: number; rebooting?: boolean; forwardedFrames?: number; sharedDeliveries?: number };

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
  let base = "";
  let token = "";
  let stats = async (): Promise<CaptureCounts> => ({ screenFrames: 0, idleFrames: 0 });
  let frame = async (): Promise<Uint8Array> => new Uint8Array(0);
  const frames = (c: CaptureCounts) => c.screenFrames + c.idleFrames;

  beforeAll(async () => {
    tempState = useTempStateDir();
    killHelpersForDevice(udid!);
    const port = await freePortAsync();
    base = `http://127.0.0.1:${port}`;
    server = spawn("node", [CLI, "--require-token", "--quiet", ...(process.env.SERVE_SIM_RECOVERY_NETWORK_CAPTURE === "1" ? ["--network-capture"] : []), "--port", String(port), udid!], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SERVE_SIM_STATE_DIR: tempState.dir },
    });
    for (const stream of [server.stdout, server.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
    }
    await waitForAsync(async () => ((await fetch(`${base}/readyz`)).ok ? true : undefined), 90_000);
    const stateFile = join(tempState.dir, `server-${udid!}.json`);
    token = (JSON.parse(readFileSync(stateFile, "utf-8")) as { token: string }).token;
    stats = async () => {
      const response = await fetch(`${base}/helper/${udid}/webrtc/stats`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`stats ${response.status}`);
      const value = await response.json() as { capture: CaptureCounts; sharedEncoderPeers?: { deliveries: number }[] };
      return { ...value.capture, sharedDeliveries: value.sharedEncoderPeers?.reduce((sum, peer) => sum + peer.deliveries, 0) };
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

  test("record-video retains one MP4 and its lease through the capture reboot action", async () => {
    const parent = process.env.SERVE_SIM_RECORDING_EVIDENCE_DIR ?? tmpdir();
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, "recording-reboot-"));
    try { simctl("uninstall", udid!, APP); } catch {}
    if (process.env.SERVE_SIM_RECOVERY_NETWORK_CAPTURE === "1") {
      const response = await fetch(`${base}/network-capture?device=${udid}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
      const reader = response.body!.getReader();
      let data = "";
      try {
        while (!/^data: .+\n/m.test(data)) data += new TextDecoder().decode((await reader.read()).value);
        const line = data.split("\n").find(line => line.startsWith("data: "))!;
        expect(JSON.parse(line.slice(6)).meta.attachment, "capture must actually be active before reboot").toBe("capturing");
      } finally { await reader.cancel(); }
    }
    let recorderOutput = "";
    const recorder = spawn("node", [CLI, "record-video", "--udid", udid!, "--output", directory], {
      env: { ...process.env, SERVE_SIM_STATE_DIR: tempState.dir }, stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [recorder.stdout, recorder.stderr]) {
      stream?.on("data", chunk => { recorderOutput += chunk.toString(); });
    }
    let viewer: RTCPeerConnection | undefined;
    let rtpSeen = 0;
    try {
      expect(await waitForAsync(async () => recorderOutput.includes("serve-sim:recording-started") ? true : undefined, 30_000), recorderOutput).toBe(true);
      const viewerCodec = process.env.SERVE_SIM_RECOVERY_VIEWER_CODEC === "h264" ? "h264" : "vp8";
      viewer = new RTCPeerConnection({ codecs: { video: [
        new RTCRtpCodecParameters({
          mimeType: viewerCodec === "h264" ? "video/H264" : "video/VP8", clockRate: 90000, payloadType: 96,
          parameters: viewerCodec === "h264" ? "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f" : undefined,
        }),
      ] } });
      viewer.addTransceiver("video", { direction: "recvonly" }).onTrack.subscribe(track => {
        track.onReceiveRtp.subscribe(() => { rtpSeen++; });
      });
      await viewer.setLocalDescription(await viewer.createOffer());
      const offer = await fetch(`${base}/helper/${udid}/webrtc/offer`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "offer", sdp: viewer.localDescription!.sdp, sessionId: crypto.randomUUID(), codec: viewerCodec }),
      });
      expect(offer.ok).toBe(true);
      await viewer.setRemoteDescription({ type: "answer", sdp: (await offer.json()).sdp });
      expect(await waitForAsync(async () => rtpSeen > 10 ? true : undefined, 30_000), output).toBe(true);
      const reboot = new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${base.replace("http", "ws")}/exec-ws`, [`serve-sim.token.${token}`], { origin: base });
        const timer = setTimeout(() => { ws.terminate(); reject(new Error("capture reboot timed out")); }, 240_000);

        ws.on("message", data => {
          const reply = JSON.parse(data.toString()) as { ready?: boolean; id?: number; exitCode?: number; stderr?: string };
          if (reply.ready) ws.send(JSON.stringify({ id: 1, action: "capture.reboot", params: { udid, enabled: false } }));
          if (reply.id !== 1) return;
          clearTimeout(timer);
          if (reply.exitCode === 0) resolve();
          else reject(new Error(reply.stderr ?? "capture reboot failed"));
          ws.close();
        });
        ws.on("error", error => { clearTimeout(timer); reject(error); });
        ws.on("close", () => { clearTimeout(timer); reject(new Error("exec socket closed before reboot completed")); });
      });
      let rebootFinished = false;
      void reboot.finally(() => { rebootFinished = true; }).catch(() => {});
      // Sample only after the native publisher has suspended, excluding the
      // transition into reboot and the first resumed frame.
      const paused = await waitForAsync(async () => {
        if (rebootFinished) return undefined;
        const before = await stats();
        if (before.rebooting !== true) return undefined;
        await Bun.sleep(750);
        const after = await stats();
        if (rebootFinished || after.rebooting !== true) return undefined;
        return { before, after };
      }, 30_000);
      expect(paused, output).toBeDefined();
      expect(typeof paused!.before.forwardedFrames).toBe("number");
      expect(paused!.after.forwardedFrames, "WebRTC must not repeat pre-reboot footage").toBe(paused!.before.forwardedFrames);
      if (viewerCodec === "h264") {
        expect(paused!.before.sharedDeliveries).toBeGreaterThan(0);
        expect(paused!.after.sharedDeliveries, "shared H.264 delivery must remain paused").toBe(paused!.before.sharedDeliveries);
      }
      await reboot;
      const receivedAtResume = rtpSeen;
      expect(await waitForAsync(async () => rtpSeen > receivedAtResume + 10 ? true : undefined, 30_000), "the same WebRTC peer must receive resumed media").toBe(true);
      expect(recorder.exitCode, recorderOutput).toBeNull();
      expect(existsSync(join(directory, "session.json")), "reboot must not finalize the recording").toBe(false);
      // Require new pixels rather than accepting a cached frame or frame counter.
      simctl("install", udid!, FIXTURE);
      simctl("launch", udid!, APP, "--input-test");
      expect(await waitForAsync(async () => isGreen(centerPixel(await frame())) ? true : undefined, 30_000), output).toBe(true);
      const appData = simctl("get_app_container", udid!, APP, "data").trim();
      const touches = () => readFileSync(join(appData, "Documents/launches.tsv"), "utf8");
      const priorTouches = touches();
      execFileSync("node", [CLI, "tap", "0.5", "0.5", "-d", udid!], { timeout: 30_000, env: { ...process.env, SERVE_SIM_STATE_DIR: tempState.dir } });
      expect(await waitForAsync(async () => touches().slice(priorTouches.length).includes("touch-ended\t") ? true : undefined, 15_000), "input must reach the new boot").toBe(true);
      await Bun.sleep(2000);
      if (process.env.SERVE_SIM_RECOVERY_STOP_SERVER === "1") server!.kill("SIGTERM");
      else recorder.kill("SIGINT");
      expect(await waitForAsync(async () => recorder.exitCode ?? undefined, 90_000), recorderOutput).toBe(0);
      const manifest = JSON.parse(readFileSync(join(directory, "session.json"), "utf8")) as {
        interruptions: { pausedAtSeconds: number; resumedAtSeconds?: number }[];
      };
      expect(manifest.interruptions).toHaveLength(1);
      const interruption = manifest.interruptions[0]!;
      expect(interruption.resumedAtSeconds).toBeGreaterThan(interruption.pausedAtSeconds);
      const mp4 = summarizeMp4(join(directory, "recording.mp4"));
      expect(mp4.codec).toBe("avc1");
      expect(mp4.durationSeconds).toBeGreaterThan(interruption.resumedAtSeconds! + 1);
      console.log("[e2e] recording reboot", JSON.stringify({ directory, ...mp4, interruption }));
    } finally {
      viewer?.close();
      if (recorder.exitCode === null) {
        recorder.kill("SIGINT");
        const ended = await waitForAsync(async () => recorder.exitCode ?? undefined, 90_000);
        if (ended === undefined) recorder.kill("SIGKILL");
      }
      if (!process.env.SERVE_SIM_RECORDING_EVIDENCE_DIR) rmSync(directory, { recursive: true, force: true });
    }
  }, 360_000);

  test("rejects a new native recording while capture is suspended", async () => {
    const capture = new NativeCapture(udid!);
    const directory = mkdtempSync(join(tmpdir(), "recording-suspended-start-"));
    let unsubscribe: (() => Promise<void>) | undefined;
    let received = false;
    try {
      await capture.start();
      unsubscribe = await capture.subscribeMjpeg(async () => { received = true; });
      expect(await waitForAsync(async () => received ? true : undefined, 15_000)).toBe(true);
      await unsubscribe(); unsubscribe = undefined;
      await capture.suspendForReboot();
      await expect(capture.startRecording(directory)).rejects.toThrow("Capture is not running");
      expect(existsSync(join(directory, "recording.mp4"))).toBe(false);
      await capture.resumeAfterReboot();
      await capture.startRecording(directory);
      await Bun.sleep(1000);
      await capture.stopRecording();
      expect(summarizeMp4(join(directory, "recording.mp4")).samples).toBeGreaterThan(0);
    } finally {
      await unsubscribe?.().catch(() => {});
      await capture.stop().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

});
