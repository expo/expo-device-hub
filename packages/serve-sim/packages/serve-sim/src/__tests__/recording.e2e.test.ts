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
import type { HingePhysicalOrientation, HingePose } from "../hinge-control";
import { servePreview, type PreviewServer } from "../runtime";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { freePortAsync, useTempStateDir } from "./helpers";
import { summarizeMp4 } from "./mp4-helpers";

// Records the booted simulator through the session endpoint and checks the file
// and its timeline: rotation, Duo panels, and an independent native pose change.
// An H.264 viewer checks recording alongside the shared resize path.
//   SERVE_SIM_TEST_UDID=<udid> bun run test:e2e -- src/__tests__/recording.e2e.test.ts
const device = e2eDevice();
requireE2E("recording e2e", device !== null);

const token = "recording-e2e-token";
let server: PreviewServer | undefined;
let base = "";
let helper = "";
let output = "";
let state: ReturnType<typeof useTempStateDir> | undefined;
let isDuoDevice = false;

interface RecordingState {
  width: number;
  height: number;
  orientation?: NativeScreenInfo["orientation"];
  screen?: "inner" | "outer";
  hingeAngle?: number;
  physicalOrientation?: HingePhysicalOrientation;
  tableMode?: boolean;
  contentRect?: { x: number; y: number; width: number; height: number };
}
interface ConfigFrame extends Pick<NativeScreenInfo, "width" | "height" | "orientation"> {
  supportsHingeAngle?: boolean;
}
interface StateEvent {
  timeMs: number;
  state: RecordingState;
}

function sameRecordingGeometry(a: RecordingState, b: RecordingState): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.orientation === b.orientation &&
    a.screen === b.screen &&
    a.contentRect?.x === b.contentRect?.x &&
    a.contentRect?.y === b.contentRect?.y &&
    a.contentRect?.width === b.contentRect?.width &&
    a.contentRect?.height === b.contentRect?.height
  );
}

function recordingGeometry(native: NativeScreenInfo): RecordingState {
  const { width, height, orientation } = native;
  const screen = isDuoDevice
    ? native.chromeIdentifier === "com.apple.dt.devicekit.chrome.phone14"
      ? "inner"
      : native.chromeIdentifier === "com.apple.dt.devicekit.chrome.phone15"
        ? "outer"
        : undefined
    : undefined;
  return {
    width,
    height,
    ...(orientation !== undefined ? { orientation } : {}),
    ...(screen !== undefined ? { screen } : {}),
  };
}

/** Wait for captured geometry; command acknowledgements cannot establish recorded pose. */
async function observedScreen(
  expected: Partial<RecordingState>,
  settleMs = 300,
): Promise<RecordingState> {
  const session = peekDeviceSession(device!);
  expect(session).toBeDefined();
  const capture = (session as unknown as { capture: NativeCapture }).capture;
  const deadline = Date.now() + 5000;
  let matchedSince: number | undefined;
  let matchedGeometry: RecordingState | undefined;
  let latest: RecordingState | undefined;
  do {
    latest = recordingGeometry(await capture.screenSize());
    const matches = (["screen", "orientation"] as const).every(
      (key) => expected[key] === undefined || latest![key] === expected[key],
    );
    if (matches && latest.width > 0 && latest.height > 0) {
      if (!matchedGeometry || !sameRecordingGeometry(matchedGeometry, latest))
        matchedSince = Date.now();
      matchedGeometry = latest;
      if (Date.now() - matchedSince! >= settleMs) return latest;
    } else {
      matchedSince = undefined;
      matchedGeometry = undefined;
    }
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error(
    `screen did not settle to ${JSON.stringify(expected)}; last geometry ${JSON.stringify(latest)}`,
  );
}

function rotate(socket: WebSocket, orientation: NonNullable<RecordingState["orientation"]>): void {
  socket.send(Buffer.concat([Buffer.from([0x07]), Buffer.from(JSON.stringify({ orientation }))]));
}

/**
 * Opens the input socket and keeps it for hinge commands. The first config frame seeds the
 * size; the hinge flag arrives with the native readback a moment later, so wait for it.
 */
function openInputSocket(): Promise<{ socket: WebSocket; config: ConfigFrame }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace("http", "ws")}${helper}/ws`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const frames: ConfigFrame[] = [];
    let settled = false;
    const finish = () => {
      if (settled || frames.length === 0) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ socket, config: frames[frames.length - 1]! });
    };
    const timeout = setTimeout(
      () => (frames.length ? finish() : reject(new Error("no config frame"))),
      10_000,
    );
    socket.on("error", reject);
    socket.on("message", (data) => {
      const frame = Buffer.from(data as Buffer);
      if (frame[0] !== 0x82) return;
      const config = JSON.parse(frame.subarray(1).toString()) as ConfigFrame;
      frames.push(config);
      if (config.supportsHingeAngle !== undefined) finish();
      else setTimeout(finish, 3000);
    });
  });
}

function selectPose(socket: WebSocket, value: HingePose): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = Date.now();
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`pose ${value} not acknowledged`));
    }, 10_000);
    const onMessage = (data: WebSocket.RawData) => {
      const frame = Buffer.from(data as Buffer);
      if (frame[0] !== 0x90) return;
      const reply = JSON.parse(frame.subarray(1).toString()) as {
        requestId?: number;
        ok?: boolean;
        error?: string;
      };
      if (reply.requestId !== requestId) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      if (reply.ok) resolve();
      else reject(new Error(reply.error ?? `pose ${value} failed`));
    };
    socket.on("message", onMessage);
    socket.send(
      Buffer.concat([
        Buffer.from([0x10]),
        Buffer.from(JSON.stringify({ requestId, command: { control: "pose", value } })),
      ]),
    );
  });
}

const recordingId = crypto.randomUUID();

/** Start with a body, or stop with the lease id of that start. */
async function recording(body: object | null): Promise<Response> {
  return fetch(`${base}${helper}/recording/video`, {
    method: body ? "POST" : "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-recording-id": recordingId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function renewRecording(): Promise<void> {
  const response = await fetch(`${base}${helper}/recording/video`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "x-recording-id": recordingId },
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(200);
}

async function senderStats(): Promise<any> {
  const response = await fetch(`${base}${helper}/webrtc/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.ok ? response.json() : null;
}

/** One receive-only H.264 viewer, so the shared canvas and the resize step are live. */
async function openViewer(codec: "h264" | "vp8" = "h264"): Promise<{ close: () => void } | null> {
  const werift: any = await import("werift");
  const pc = new werift.RTCPeerConnection({
    codecs: {
      video: [
        new werift.RTCRtpCodecParameters({
          mimeType: codec === "h264" ? "video/H264" : "video/VP8",
          clockRate: 90000,
          payloadType: 102,
          parameters:
            codec === "h264"
              ? "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
              : undefined,
        }),
      ],
    },
  });
  pc.addTransceiver("video", { direction: "recvonly" });
  await pc.setLocalDescription(await pc.createOffer());
  const response = await fetch(`${base}${helper}/webrtc/offer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      type: "offer",
      sdp: pc.localDescription.sdp,
      sessionId: crypto.randomUUID(),
      codec,
    }),
  });
  if (!response.ok) throw new Error(`offer failed: ${response.status}`);
  await pc.setRemoteDescription({
    type: "answer",
    sdp: ((await response.json()) as { sdp: string }).sdp,
  });
  return { close: () => pc.close() };
}

beforeAll(async () => {
  if (!device) return;
  const devices = JSON.parse(
    execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" }),
  ).devices as Record<string, Array<{ udid: string; deviceTypeIdentifier: string }>>;
  const simulator = Object.values(devices)
    .flat()
    .find((simulator) => simulator.udid === device);
  expect(simulator).toBeDefined();
  isDuoDevice =
    simulator!.deviceTypeIdentifier === "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";
  state = useTempStateDir();
  const port = await freePortAsync();
  server = await servePreview({
    port,
    host: "127.0.0.1",
    middleware: simMiddleware({
      basePath: "/",
      device,
      execToken: token,
      requirePreviewToken: false,
    }),
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
    expect(((await response.json()) as { error: string }).error).toBe("invalid_recording_request");
  }
});

test.skipIf(!device)(
  "records the simulator to a native-size H.264 file with a manifest",
  async () => {
    const { socket, config } = await openInputSocket();
    let viewer: Awaited<ReturnType<typeof openViewer>> = null;
    let recordingActive = false;
    let externalCommandAt: number | undefined;
    const states: Array<{ state: RecordingState; commandedAt: number }> = [];
    try {
      expect(config.width).toBeGreaterThan(0);
      if (isDuoDevice) expect(config.supportsHingeAngle).toBe(true);
      if (isDuoDevice) {
        execFileSync("bash", [join(import.meta.dir, "fixtures/duo/install.sh")], {
          env: { ...process.env, DUO_E2E_DEVICE: device! },
          stdio: "pipe",
          timeout: 30_000,
        });
      } else {
        execFileSync("xcrun", ["simctl", "launch", device!, "com.apple.mobilesafari"], {
          stdio: "pipe",
          timeout: 10_000,
        });
      }
      if (config.supportsHingeAngle) await selectPose(socket, "open");
      else rotate(socket, "portrait");
      const initial = await observedScreen(
        config.supportsHingeAngle ? { screen: "inner" } : { orientation: "portrait" },
        isDuoDevice ? 2000 : 300,
      );
      viewer = await openViewer();
      const started = await recording({ start: true, output, recordingId });
      expect(started.status).toBe(200);
      expect(await started.json()).toEqual({ recording: true });
      recordingActive = true;
      const startedAt = Date.now();
      // Leave the initial pose on screen long enough to be appended before any command.
      await Bun.sleep(750);

      const observeTransition = async (
        command: () => Promise<void> | void,
        expected: Partial<RecordingState>,
      ) => {
        await renewRecording();
        const commandedAt = Date.now();
        await command();
        const geometry = await observedScreen(expected);
        states.push({ state: { ...geometry, ...expected }, commandedAt });
        // Allow native pose observation and a successful writer append; verify both in the manifest.
        await Bun.sleep(750);
      };

      if (config.supportsHingeAngle) {
        // A fresh motion transition establishes tabletop activity and both panels.
        await observeTransition(() => selectPose(socket, "tent"), {
          screen: "outer",
          orientation: "landscape_left",
          hingeAngle: 80,
          physicalOrientation: "facedown",
          tableMode: true,
        });
        await observeTransition(() => selectPose(socket, "open"), {
          screen: "inner",
          hingeAngle: 180,
          physicalOrientation: "portrait",
          tableMode: false,
        });
      }

      for (const orientation of ["landscape_left", "portrait"] as const) {
        if (
          states.at(-1)?.state.orientation === orientation ||
          (!states.length && initial.orientation === orientation)
        )
          continue;
        await observeTransition(() => rotate(socket, orientation), { orientation });
      }

      if (config.supportsHingeAngle) {
        await renewRecording();
        externalCommandAt = Date.now();
        execFileSync(
          process.execPath,
          [
            fileURLToPath(new URL("./fixtures/recording-hinge.child.ts", import.meta.url)),
            device!,
            "45.5",
          ],
          { stdio: "pipe", timeout: 10_000 },
        );
        // No server command: the shared native observer must discover this change.
        await Bun.sleep(3500);
        const stats = await senderStats();
        expect(viewer).not.toBeNull();
        expect(stats).not.toBeNull();
        // The folded panel is smaller than the canvas, so frames were letterboxed on the resize queue.
        expect(stats.sharedCanvas.width).toBeGreaterThan(0);
        expect(stats.viewerResize.scaled).toBeGreaterThan(0);
        expect(stats.viewerResize.failures).toBe(0);
        expect(stats.capture.canvasMismatchDrops ?? 0).toBeLessThan(10);
        console.log(
          "[e2e] duo canvas",
          JSON.stringify(stats.sharedCanvas),
          "resize",
          JSON.stringify(stats.viewerResize),
        );
      }
      viewer?.close();
      viewer = await openViewer("vp8");
      await Bun.sleep(1000);
      const elapsed = (Date.now() - startedAt) / 1000;

      const recordingStoppedAt = Date.now();
      const stopped = await recording(null);
      expect(stopped.status).toBe(200);
      recordingActive = false;
      const { manifest: manifestPath } = (await stopped.json()) as { manifest: string };
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        firstFrameWallClock: { unixMs: number; iso8601: string };
        width: number;
        height: number;
        recording: string;
        deviceStates?: StateEvent[];
      };
      expect(manifest.recording).toBe("recording.mp4");
      expect(manifest.firstFrameWallClock.unixMs).toBeGreaterThanOrEqual(startedAt - 2000);
      expect(new Date(manifest.firstFrameWallClock.iso8601).getTime()).toBe(
        manifest.firstFrameWallClock.unixMs,
      );

      const mp4 = summarizeMp4(join(output, manifest.recording));
      expect(mp4.codec).toBe("avc1");
      expect(mp4.width).toBe(manifest.width);
      expect(mp4.height).toBe(manifest.height);
      expect(mp4.width % 2).toBe(0);
      expect(mp4.height % 2).toBe(0);
      expect(manifest.deviceStates).toBeDefined();
      const events = manifest.deviceStates!;
      expect(events[0]!.timeMs).toBe(0);
      expect(events[0]!.state).toMatchObject(initial);
      for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        expect(Number.isFinite(event.timeMs)).toBe(true);
        expect(event.timeMs).toBeGreaterThanOrEqual(0);
        expect(event.timeMs).toBeLessThanOrEqual(mp4.durationSeconds * 1000);
        expect(event.state.width).toBeGreaterThan(0);
        expect(event.state.height).toBeGreaterThan(0);
        expect(event.state).not.toHaveProperty("screenId");
        const rect = event.state.contentRect;
        expect(rect).toBeDefined();
        for (const value of Object.values(rect!)) expect(Number.isInteger(value)).toBe(true);
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.y).toBeGreaterThanOrEqual(0);
        expect(rect!.width).toBeGreaterThan(0);
        expect(rect!.height).toBeGreaterThan(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(manifest.width);
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(manifest.height);
        if (i > 0) {
          expect(event.timeMs).toBeGreaterThan(events[i - 1]!.timeMs);
          expect(event.state).not.toEqual(events[i - 1]!.state);
        }
      }
      // The matching segment must cover frames in this command's interval. An
      // unchanged state need not emit again; an earlier, finished transient cannot count.
      let previousIndex = 0;
      for (const [transition, { state, commandedAt }] of states.entries()) {
        const from = Math.max(0, commandedAt - manifest.firstFrameWallClock.unixMs);
        const until =
          (states[transition + 1]?.commandedAt ?? externalCommandAt ?? recordingStoppedAt) -
          manifest.firstFrameWallClock.unixMs;
        const index = events.findIndex(
          (event, i) =>
            i >= previousIndex &&
            event.timeMs < until &&
            (events[i + 1]?.timeMs ?? mp4.durationSeconds * 1000) > from &&
            Object.entries(state).every(
              ([key, value]) => event.state[key as keyof RecordingState] === value,
            ),
        );
        if (index < 0)
          console.error(
            "[e2e] missing recording segment",
            JSON.stringify({ state, from, until, events }),
          );
        expect(
          index,
          `missing recording state ${JSON.stringify(state)} during ${from.toFixed(0)}–${until.toFixed(0)} ms`,
        ).toBeGreaterThanOrEqual(previousIndex);
        previousIndex = index;
      }
      if (externalCommandAt !== undefined) {
        const external = events.at(-1);
        expect(external).toBeDefined();
        expect(external!.state.hingeAngle).toBe(45.5);
        expect(external!.timeMs).toBeGreaterThanOrEqual(
          externalCommandAt - manifest.firstFrameWallClock.unixMs - 250,
        );
        expect(external!.state.physicalOrientation).toBe("portrait");
        expect(external!.state.tableMode).toBe(false);
      }
      if (!isDuoDevice) {
        for (const { state } of events) {
          expect(state.screen).toBeUndefined();
          expect(state.hingeAngle).toBeUndefined();
          expect(state.physicalOrientation).toBeUndefined();
          expect(state.tableMode).toBeUndefined();
        }
      }
      // The fixed canvas holds the initial panel and panels in the upright poses.
      // Screen rotation can swap dimensions independently of physical orientation;
      // those frames are letterboxed rather than changing the output dimensions.
      const seen = [
        initial,
        ...states
          .map(({ state }) => state)
          .filter((state) => state.physicalOrientation === "portrait"),
      ];
      for (const panel of seen) {
        expect(mp4.width).toBeGreaterThanOrEqual(panel.width - 1);
        expect(mp4.height).toBeGreaterThanOrEqual(panel.height - 1);
      }
      // The recorder targets 60 samples per second. A loaded VM coalesces timer ticks, and a
      // fold transition drops some, so the floor is 30; the rate is logged for the record.
      console.log(
        `[e2e] recording ${mp4.width}x${mp4.height} ${mp4.samples} samples in ${mp4.durationSeconds.toFixed(2)} s`,
      );
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
  },
  60_000,
);
