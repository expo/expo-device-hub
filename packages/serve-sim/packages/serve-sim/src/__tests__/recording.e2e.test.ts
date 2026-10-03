import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import { peekDeviceSession } from "../device-session";
import { simMiddleware } from "../middleware";
import type { NativeCapture, NativeScreenInfo } from "../native";
import type { HingeControlCommand, HingePhysicalOrientation, HingePose } from "../hinge-control";
import { servePreview, type PreviewServer } from "../runtime";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { freePortAsync, useTempStateDir } from "./helpers";
import { summarizeMp4 } from "./mp4-helpers";

// Records the booted simulator through the session endpoint and checks the file
// and its device-state timeline while Safari allows the screen to rotate. On a
// Duo (the config frame reports hinge support), folds and physical poses are
// recorded too, and an H.264 viewer session checks
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

interface RecordingState {
  width: number;
  height: number;
  orientation?: NativeScreenInfo["orientation"];
  screenId?: number;
  hingeAngle?: number;
  physicalOrientation?: HingePhysicalOrientation;
  tableMode?: boolean;
}
interface ConfigFrame extends RecordingState { supportsHingeAngle?: boolean }
interface StateEvent { timeMs: number; state: RecordingState }

function recordingState(config: ConfigFrame): RecordingState {
  const { width, height, orientation, screenId, hingeAngle, physicalOrientation, tableMode } = config;
  return {
    width, height,
    ...(orientation !== undefined ? { orientation } : {}),
    ...(screenId !== undefined ? { screenId } : {}),
    ...(hingeAngle !== undefined ? { hingeAngle } : {}),
    ...(physicalOrientation !== undefined ? { physicalOrientation } : {}),
    ...(tableMode !== undefined ? { tableMode } : {}),
  };
}

/** Check the server's actual capture metadata, since iPhone config can echo a rotate command early. */
async function observedState(frames: ConfigFrame[], expected: Partial<RecordingState>): Promise<RecordingState> {
  const session = peekDeviceSession(device!);
  expect(session).toBeDefined();
  const capture = (session as unknown as { capture: NativeCapture }).capture;
  const deadline = Date.now() + 5000;
  let matchedSince: number | undefined;
  let latest: RecordingState | undefined;
  do {
    const native = await capture.screenSize();
    latest = recordingState(frames[frames.length - 1]!);
    const matches = Object.entries(expected).every(([key, value]) => latest![key as keyof RecordingState] === value);
    if (matches && native.orientation === latest.orientation && native.screenId === latest.screenId &&
      native.width === latest.width && native.height === latest.height) {
      matchedSince ??= Date.now();
      // Avoid accepting the previous orientation during a native panel handoff.
      if (Date.now() - matchedSince >= 300) return latest;
    } else matchedSince = undefined;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`screen did not settle to ${JSON.stringify(expected)}; last state ${JSON.stringify(latest)}`);
}

function rotate(socket: WebSocket, orientation: NonNullable<RecordingState["orientation"]>): void {
  socket.send(Buffer.concat([Buffer.from([0x07]), Buffer.from(JSON.stringify({ orientation }))]));
}

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

function selectHingeControl(socket: WebSocket, command: HingeControlCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = Date.now();
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`hinge ${JSON.stringify(command)} not acknowledged`));
    }, 10_000);
    const onMessage = (data: WebSocket.RawData) => {
      const frame = Buffer.from(data as Buffer);
      if (frame[0] !== 0x90) return;
      const reply = JSON.parse(frame.subarray(1).toString()) as { requestId?: number; ok?: boolean; error?: string };
      if (reply.requestId !== requestId) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      if (reply.ok) resolve();
      else reject(new Error(reply.error ?? "hinge command failed"));
    };
    socket.on("message", onMessage);
    socket.send(Buffer.concat([Buffer.from([0x10]), Buffer.from(JSON.stringify({ requestId, command }))]));
  });
}

function selectPose(socket: WebSocket, value: HingePose): Promise<void> {
  return selectHingeControl(socket, { control: "pose", value });
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

async function renewRecording(): Promise<void> {
  const response = await fetch(`${base}${helper}/recording/video`, {
    method: "PUT", headers: { Authorization: `Bearer ${token}`, "x-recording-id": recordingId },
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(200);
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
  let viewer: Awaited<ReturnType<typeof openViewer>> = null;
  let recordingActive = false;
  let externalCommandAt: number | undefined;
  const states: Array<{ state: RecordingState; commandedAt: number }> = [];
  try {
    expect(config.width).toBeGreaterThan(0);
    execFileSync("xcrun", ["simctl", "launch", device!, "com.apple.mobilesafari"], {
      stdio: "pipe", timeout: 10_000,
    });
    if (config.supportsHingeAngle) await selectPose(socket, "open");
    else rotate(socket, "portrait");
    const initial = await observedState(frames, config.supportsHingeAngle
      ? { screenId: 3, hingeAngle: 180, physicalOrientation: "portrait", tableMode: false }
      : { orientation: "portrait" });
    viewer = await openViewer();
    const started = await recording({ start: true, output, recordingId });
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ recording: true });
    recordingActive = true;
    const startedAt = Date.now();
    // Leave the initial pose on screen long enough to be appended before any command.
    await Bun.sleep(750);

    const observeTransition = async (command: () => Promise<void> | void, expected: Partial<RecordingState>) => {
      await renewRecording();
      const commandedAt = Date.now();
      await command();
      const state = await observedState(frames, expected);
      states.push({ state, commandedAt });
      // A stable state must reach at least one successfully appended video frame.
      await Bun.sleep(500);
    };

    for (const orientation of ["portrait", "landscape_left", "landscape_right", "portrait"] as const) {
      if (states.at(-1)?.state.orientation === orientation || (!states.length && initial.orientation === orientation)) continue;
      await observeTransition(() => rotate(socket, orientation), { orientation });
    }

    if (config.supportsHingeAngle) {
      // Fold and unfold while recording: the file keeps one canvas, the active panel changes.
      for (const [pose, expected] of [
        ["open", { screenId: 3, hingeAngle: 180, physicalOrientation: "portrait", tableMode: false }],
        ["closed", { screenId: 1, orientation: "portrait", hingeAngle: 0, physicalOrientation: "portrait", tableMode: false }],
        ["open", { screenId: 3, hingeAngle: 180, physicalOrientation: "portrait", tableMode: false }],
        ["book", { screenId: 3, hingeAngle: 90, physicalOrientation: "portrait", tableMode: false }],
        ["laptop", { screenId: 3, hingeAngle: 90, physicalOrientation: "landscape-left", tableMode: false }],
        ["tent", { screenId: 1, orientation: "landscape_left", hingeAngle: 80, physicalOrientation: "facedown", tableMode: true }],
      ] as const) {
        await observeTransition(() => selectPose(socket, pose), expected);
      }
      for (const [command, expected] of [
        [{ control: "table", value: false }, { hingeAngle: 80, physicalOrientation: "facedown", tableMode: false }],
        [{ control: "physical", value: "faceup" }, { hingeAngle: 80, physicalOrientation: "faceup", tableMode: false }],
        [{ control: "angle", value: 65.5 }, { hingeAngle: 65.5, physicalOrientation: "faceup", tableMode: false }],
      ] as const) {
        await observeTransition(() => selectHingeControl(socket, command), expected);
      }
      await renewRecording();
      externalCommandAt = Date.now();
      execFileSync(process.execPath, [
        fileURLToPath(new URL("./fixtures/recording-hinge.child.ts", import.meta.url)), device!, "45.5",
      ], { stdio: "pipe", timeout: 10_000 });
      // No server readback request: the recording's background poll must discover this change.
      await Bun.sleep(3500);
      const stats = await senderStats();
      expect(viewer).not.toBeNull();
      expect(stats).not.toBeNull();
      // The folded panel is smaller than the canvas, so frames were letterboxed on the resize queue.
      expect(stats.sharedCanvas.width).toBeGreaterThan(0);
      expect(stats.viewerResize.scaled).toBeGreaterThan(0);
      expect(stats.viewerResize.failures).toBe(0);
      expect(stats.capture.canvasMismatchDrops ?? 0).toBeLessThan(10);
      console.log("[e2e] duo canvas", JSON.stringify(stats.sharedCanvas), "resize", JSON.stringify(stats.viewerResize));
    }
    const elapsed = (Date.now() - startedAt) / 1000;

    const stopped = await recording(null);
    expect(stopped.status).toBe(200);
    recordingActive = false;
    const { manifest: manifestPath } = await stopped.json() as { manifest: string };
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      firstFrameWallClock: { unixMs: number; iso8601: string }; width: number; height: number; recording: string;
      deviceStates?: StateEvent[];
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
    expect(manifest.deviceStates).toBeDefined();
    const events = manifest.deviceStates!;
    expect(events[0]).toEqual({ timeMs: 0, state: initial });
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      expect(Number.isFinite(event.timeMs)).toBe(true);
      expect(event.timeMs).toBeGreaterThanOrEqual(0);
      expect(event.timeMs).toBeLessThanOrEqual(mp4.durationSeconds * 1000);
      expect(event.state.width).toBeGreaterThan(0);
      expect(event.state.height).toBeGreaterThan(0);
      expect(events.filter(next => next.timeMs >= event.timeMs && next.timeMs < event.timeMs + 1000 - 0.01).length).toBeLessThanOrEqual(4);
      if (i > 0) {
        expect(event.timeMs).toBeGreaterThan(events[i - 1]!.timeMs);
        expect(event.state).not.toEqual(events[i - 1]!.state);
      }
    }
    // Every completed transition must appear in order, with the panel geometry
    // and hinge/physical state together rather than just a command acknowledgement.
    let previousIndex = 0;
    for (const { state, commandedAt } of states) {
      // Native capture can know a physical rotation that the legacy config omits.
      const index = events.findIndex((event, i) => i > previousIndex &&
        Object.entries(state).every(([key, value]) => event.state[key as keyof RecordingState] === value));
      expect(index, `missing recording state ${JSON.stringify(state)}`).toBeGreaterThan(previousIndex);
      expect(events[index]!.timeMs).toBeGreaterThanOrEqual(commandedAt - manifest.firstFrameWallClock.unixMs - 250);
      previousIndex = index;
    }
    if (externalCommandAt !== undefined) {
      const external = events.at(-1);
      expect(external).toBeDefined();
      expect(external!.state.hingeAngle).toBe(45.5);
      expect(external!.timeMs).toBeGreaterThanOrEqual(externalCommandAt - manifest.firstFrameWallClock.unixMs - 250);
      expect(external!.state.physicalOrientation).toBeUndefined();
      expect(external!.state.tableMode).toBeUndefined();
    }
    if (!config.supportsHingeAngle) {
      for (const { state } of events) {
        expect(state.hingeAngle).toBeUndefined();
        expect(state.physicalOrientation).toBeUndefined();
        expect(state.tableMode).toBeUndefined();
      }
    }
    // The fixed canvas holds the initial panel and panels in the upright poses.
    // Screen rotation can swap dimensions independently of physical orientation;
    // those frames are letterboxed rather than changing the output dimensions.
    const seen = [initial, ...states.map(({ state }) => state).filter(state => state.physicalOrientation === "portrait")];
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
    if (recordingActive) await recording(null).catch(() => {});
    viewer?.close();
    if (config.supportsHingeAngle) await selectPose(socket, "open").catch(() => {});
    else if (config.orientation) rotate(socket, config.orientation);
    socket.close();
  }
}, 60_000);
