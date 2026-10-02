import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { freePortAsync, useTempStateDir } from "./helpers";
import { summarizeMp4 } from "./mp4-helpers";

// Records the booted simulator through the session endpoint and checks the file
// and manifest. On a Duo (the config frame reports hinge support) the device is
// folded and unfolded during the recording, and an H.264 viewer session checks
// that the shared canvas stays fixed while the resize step letterboxes the
// smaller panel. Run with a booted simulator and no other serve-sim on it:
//   SERVE_SIM_TEST_UDID=<udid> bun test src/__tests__/recording.e2e.test.ts
const device = e2eDevice();
requireE2E("recording e2e", device !== null);

const token = "recording-e2e-token";
let server: PreviewServer | undefined;
let base = "";
let helper = "";
let output = "";
let state: ReturnType<typeof useTempStateDir> | undefined;

interface ConfigFrame { width: number; height: number; supportsHingeAngle?: boolean; screenId?: number }

/**
 * Opens the input socket and keeps it for hinge commands. The first config frame seeds the
 * size; the hinge flag arrives with the native readback a moment later, so wait for it.
 */
function openInputSocket(): Promise<{ socket: WebSocket; config: ConfigFrame; frames: ConfigFrame[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace("http", "ws")}${helper}/ws`, { headers: { Authorization: `Bearer ${token}` } });
    const frames: ConfigFrame[] = [];
    let settled = false;
    const finish = () => {
      if (settled || frames.length === 0) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ socket, config: frames[frames.length - 1]!, frames });
    };
    const timeout = setTimeout(() => (frames.length ? finish() : reject(new Error("no config frame"))), 10_000);
    socket.on("error", reject);
    socket.on("message", data => {
      const frame = Buffer.from(data as Buffer);
      if (frame[0] !== 0x82) return;
      const config = JSON.parse(frame.subarray(1).toString()) as ConfigFrame;
      frames.push(config);
      if (config.supportsHingeAngle !== undefined) finish();
      else setTimeout(finish, 3000);
    });
  });
}

function selectPose(socket: WebSocket, value: "open" | "closed" | "book" | "tent"): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = Date.now();
    const timeout = setTimeout(() => reject(new Error(`pose ${value} not acknowledged`)), 10_000);
    const onMessage = (data: WebSocket.RawData) => {
      const frame = Buffer.from(data as Buffer);
      if (frame[0] !== 0x90) return;
      const reply = JSON.parse(frame.subarray(1).toString()) as { requestId?: number; ok?: boolean; error?: string };
      if (reply.requestId !== requestId) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      if (reply.ok) resolve();
      else reject(new Error(reply.error ?? `pose ${value} failed`));
    };
    socket.on("message", onMessage);
    socket.send(Buffer.concat([Buffer.from([0x10]), Buffer.from(JSON.stringify({ requestId, command: { control: "pose", value } }))]));
  });
}

const recordingId = crypto.randomUUID();

/** Start with a body, or stop with the lease id of that start. */
async function recording(body: object | null): Promise<Response> {
  return fetch(`${base}${helper}/recording/video`, {
    method: body ? "POST" : "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-recording-id": recordingId },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function senderStats(): Promise<any> {
  const response = await fetch(`${base}${helper}/webrtc/stats`, { headers: { Authorization: `Bearer ${token}` } });
  return response.ok ? response.json() : null;
}

/** One receive-only H.264 viewer, so the shared canvas and the resize step are live. */
async function openViewer(): Promise<{ close: () => void } | null> {
  const werift: any = await import("werift");
  const pc = new werift.RTCPeerConnection({
    codecs: { video: [new werift.RTCRtpCodecParameters({
      mimeType: "video/H264", clockRate: 90000, payloadType: 102,
      parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    })] },
  });
  pc.addTransceiver("video", { direction: "recvonly" });
  await pc.setLocalDescription(await pc.createOffer());
  const response = await fetch(`${base}${helper}/webrtc/offer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: "offer", sdp: pc.localDescription.sdp, sessionId: crypto.randomUUID(), codec: "h264" }),
  });
  if (!response.ok) throw new Error(`offer failed: ${response.status}`);
  await pc.setRemoteDescription({ type: "answer", sdp: (await response.json() as { sdp: string }).sdp });
  return { close: () => pc.close() };
}

beforeAll(async () => {
  if (!device) return;
  state = useTempStateDir();
  const port = await freePortAsync();
  server = await servePreview({
    port, host: "127.0.0.1",
    middleware: simMiddleware({ basePath: "/", device, execToken: token, requirePreviewToken: false }),
  });
  base = `http://127.0.0.1:${port}`;
  helper = `/helper/${device}`;
  output = mkdtempSync(join(tmpdir(), "serve-sim-recording-e2e-"));
});

afterAll(() => {
  server?.stop(true);
  if (output) rmSync(output, { recursive: true, force: true });
  state?.restore();
});

test.skipIf(!device)("rejects recording IDs with control characters", async () => {
  for (const recordingId of ["bad\nidentifier", "bad-id\n"]) {
    const response = await recording({ start: true, output, recordingId });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe("invalid_recording_request");
  }
});

test.skipIf(!device)("records the simulator to a native-size H.264 file with a manifest", async () => {
  const { socket, config, frames } = await openInputSocket();
  const viewer = await openViewer();
  const poses: Array<[ConfigFrame, number]> = [];
  try {
    expect(config.width).toBeGreaterThan(0);
    const started = await recording({ start: true, output, recordingId });
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ recording: true });
    const startedAt = Date.now();

    if (config.supportsHingeAngle) {
      // Fold and unfold while recording: the file keeps one canvas, the active panel changes.
      for (const pose of ["open", "closed", "open"] as const) {
        await selectPose(socket, pose);
        await Bun.sleep(1500);
        poses.push([frames[frames.length - 1]!, Date.now()]);
      }
      const stats = await senderStats();
      expect(viewer).not.toBeNull();
      expect(stats).not.toBeNull();
      // The folded panel is smaller than the canvas, so frames were letterboxed on the resize queue.
      expect(stats.sharedCanvas.width).toBeGreaterThan(0);
      expect(stats.viewerResize.scaled).toBeGreaterThan(0);
      expect(stats.viewerResize.failures).toBe(0);
      expect(stats.capture.canvasMismatchDrops ?? 0).toBeLessThan(10);
      console.log("[e2e] duo canvas", JSON.stringify(stats.sharedCanvas), "resize", JSON.stringify(stats.viewerResize));
    } else {
      await Bun.sleep(3000);
    }
    const elapsed = (Date.now() - startedAt) / 1000;

    const stopped = await recording(null);
    expect(stopped.status).toBe(200);
    const { manifest: manifestPath } = await stopped.json() as { manifest: string };
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      firstFrameWallClock: { unixMs: number; iso8601: string }; width: number; height: number; recording: string;
    };
    expect(manifest.recording).toBe("recording.mp4");
    expect(manifest.firstFrameWallClock.unixMs).toBeGreaterThanOrEqual(startedAt - 2000);
    expect(new Date(manifest.firstFrameWallClock.iso8601).getTime()).toBe(manifest.firstFrameWallClock.unixMs);

    const mp4 = summarizeMp4(join(output, manifest.recording));
    expect(mp4.codec).toBe("avc1");
    expect(mp4.width).toBe(manifest.width);
    expect(mp4.height).toBe(manifest.height);
    expect(mp4.width % 2).toBe(0);
    expect(mp4.height % 2).toBe(0);
    // The canvas holds every panel seen during the recording; a single panel is the screen itself.
    const seen = poses.length ? poses.map(([f]) => f) : [config];
    for (const panel of seen) {
      expect(mp4.width).toBeGreaterThanOrEqual(panel.width - 1);
      expect(mp4.height).toBeGreaterThanOrEqual(panel.height - 1);
    }
    // The recorder targets 60 samples per second. A loaded VM coalesces timer ticks, and a
    // fold transition drops some, so the floor is 30; the rate is logged for the record.
    console.log(`[e2e] recording ${mp4.width}x${mp4.height} ${mp4.samples} samples in ${mp4.durationSeconds.toFixed(2)} s`);
    expect(mp4.durationSeconds).toBeGreaterThan(elapsed - 1.5);
    expect(mp4.samples / mp4.durationSeconds).toBeGreaterThan(30);
    expect(mp4.samples / mp4.durationSeconds).toBeLessThanOrEqual(61);
  } finally {
    viewer?.close();
    if (config.supportsHingeAngle) await selectPose(socket, "open").catch(() => {});
    socket.close();
  }
}, 60_000);
