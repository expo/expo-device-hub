import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFoldableDisplays } from "../src/fold.ts";
import { GrpcRecordingEncoder, type GrpcRecordingOutput } from "../src/grpc-recording-encoder.ts";
import {
  createTimedKeyFrameProbe,
  ffmpegEncoderArgs,
  type H264EncoderOpts,
} from "../src/h264-encoder.ts";
import {
  captureBox,
  captureSize,
  placeOnCanvas,
  poseForGeometry,
  recordingCanvas,
  recordingGeometry,
  type RecordingGeometry,
} from "../src/recording-canvas.ts";
import { ScreenRecording } from "../src/screen-recording.ts";
import type { VideoFrame } from "../src/scrcpy.ts";

// The Pixel 9 Pro Fold AVD profile: the inner panel and the region that the closed device shows.
const PIXEL_9_PRO_FOLD = `hw.lcd.width = 2076
hw.lcd.height = 2152
hw.displayRegion.0.1.xOffset = 0
hw.displayRegion.0.1.width = 1080
hw.displayRegion.0.1.height = 2424
hw.displayRegion.0.2.width = 0
hw.sensor.hinge = true
hw.sensor.hinge.ranges = 0-180
hw.sensor.posture_list = 1, 2, 3
hw.sensor.hinge_angles_posture_definitions = 0-30, 30-150, 150-180
hw.sensor.hinge.fold_to_displayRegion.0.1_at_posture = 1
`;
const DISPLAYS = {
  inner: { width: 2076, height: 2152 },
  outer: { width: 1080, height: 2424 },
  closedHinge: { min: 0, max: 30 },
};
const LAYOUT = recordingCanvas(DISPLAYS, 960);
const INNER: RecordingGeometry = recordingGeometry({ width: 926, height: 960 }, LAYOUT);
const OUTER: RecordingGeometry = recordingGeometry({ width: 427, height: 960 }, LAYOUT);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("reads a foldable's two displays from the emulator's hardware config", () => {
  expect(parseFoldableDisplays(PIXEL_9_PRO_FOLD)).toEqual(DISPLAYS);
  expect(parseFoldableDisplays(PIXEL_9_PRO_FOLD.replace("hinge = true", "hinge = yes"))).toEqual(
    DISPLAYS,
  );
  // The closed posture's angles come from the range at its index in the posture list.
  expect(
    parseFoldableDisplays(
      PIXEL_9_PRO_FOLD.replace("posture_list = 1, 2, 3", "posture_list = 3, 2, 1").replace(
        "0-30, 30-150, 150-180",
        "150-180, 30-150, 0-25",
      ),
    )?.closedHinge,
  ).toEqual({ min: 0, max: 25 });
  // Without them, the displays stay and the hinge has no closed range.
  const { closedHinge: _, ...displaysOnly } = DISPLAYS;
  expect(
    parseFoldableDisplays(PIXEL_9_PRO_FOLD.replace(/^hw\.sensor\.hinge_angles.*\n/m, "")),
  ).toEqual(displaysOnly);
  // A phone has no hinge, and a hinge without a fold region names no second display.
  expect(parseFoldableDisplays(PIXEL_9_PRO_FOLD.replace("hinge = true", "hinge = false"))).toBe(
    null,
  );
  expect(parseFoldableDisplays(PIXEL_9_PRO_FOLD.replace("0.1.width = 1080", "0.1.width = 0"))).toBe(
    null,
  );
  // A fold-out profile shows its region at another posture than closed (1), or the config does
  // not say; neither gets the fold canvas.
  expect(
    parseFoldableDisplays(PIXEL_9_PRO_FOLD.replace("_at_posture = 1", "_at_posture = 4")),
  ).toBe(null);
  expect(
    parseFoldableDisplays(
      PIXEL_9_PRO_FOLD.replace("hw.sensor.hinge.fold_to_displayRegion.0.1_at_posture = 1\n", ""),
    ),
  ).toBe(null);
});

test("sizes the canvas to both displays' captures in the gRPC box", () => {
  // The emulator fits each display into the 960 px box; serve-emu crops odd sizes to even.
  expect(captureSize(DISPLAYS.inner, 960)).toEqual({ width: 926, height: 960 });
  expect(captureSize(DISPLAYS.outer, 960)).toEqual({ width: 426, height: 960 });
  expect(captureSize(DISPLAYS.outer, 0)).toEqual(DISPLAYS.outer);
  // The emulator does not enlarge a display that is smaller than the box.
  expect(captureSize(DISPLAYS.inner, 3000)).toEqual(DISPLAYS.inner);
  expect(LAYOUT.canvas).toEqual({ width: 926, height: 960 });
  expect(recordingCanvas(DISPLAYS, 0).canvas).toEqual({ width: 2076, height: 2424 });
});

test("sizes a native-size MMAP canvas from the startup display's longest side", () => {
  const box = (imageMode: string, startup: "inner" | "outer" | null, maxSize = 0) =>
    captureBox({ maxSize, imageMode, displays: DISPLAYS, startup });
  expect(box("mmap", "inner")).toBe(2152);
  expect(box("mmap", "outer")).toBe(2424);
  // A set maxSize, another image mode, or an unknown startup display keep their own box.
  expect(box("mmap", "inner", 960)).toBe(960);
  expect(box("rgb888", "inner")).toBe(0);
  expect(box("mmap", null)).toBe(0);
  // Started open, the outer display is scaled into the inner display's 2152 px box.
  expect(recordingCanvas(DISPLAYS, box("mmap", "inner")).canvas).toEqual({
    width: 2076,
    height: 2152,
  });
  expect(recordingCanvas(DISPLAYS, box("mmap", "outer")).canvas).toEqual({
    width: 2076,
    height: 2424,
  });
});

test("centers each display on the canvas, and scales one that does not fit", () => {
  expect(INNER).toEqual({
    width: 2076,
    height: 2152,
    screen: "inner",
    contentRect: { x: 0, y: 0, width: 926, height: 960 },
  });
  expect(OUTER).toEqual({
    width: 1080,
    height: 2424,
    screen: "outer",
    contentRect: { x: 250, y: 0, width: 426, height: 960 },
  });
  // A turned inner display is wider than the canvas.
  expect(placeOnCanvas({ width: 960, height: 926 }, LAYOUT.canvas)).toEqual({
    x: 0,
    y: 34,
    width: 926,
    height: 892,
  });
  expect(recordingGeometry({ width: 960, height: 926 }, LAYOUT)).toMatchObject({
    width: 2152,
    height: 2076,
    screen: "inner",
  });
});

test("leaves the hinge unknown while its reading contradicts the shown display", () => {
  const closed = DISPLAYS.closedHinge;
  expect(poseForGeometry(OUTER, { hingeAngle: 0, orientation: "portrait" }, closed)).toEqual({
    hingeAngle: 0,
    orientation: "portrait",
  });
  // The orientation stays when the hinge goes.
  expect(
    poseForGeometry(OUTER, { hingeAngle: 180, orientation: "landscape_left" }, closed),
  ).toEqual({ orientation: "landscape_left" });
  expect(poseForGeometry(INNER, { hingeAngle: 0 }, closed)).toEqual({});
  expect(poseForGeometry(INNER, { hingeAngle: 29.5 }, closed)).toEqual({});
  expect(poseForGeometry(INNER, { hingeAngle: 30 }, closed)).toEqual({ hingeAngle: 30 });
  expect(poseForGeometry(INNER, { hingeAngle: 90 }, closed)).toEqual({ hingeAngle: 90 });
  // A profile without posture angles keeps every reading.
  expect(poseForGeometry(OUTER, { hingeAngle: 180 }, undefined)).toEqual({ hingeAngle: 180 });
});

test("adds a canvas and a centered picture to the ffmpeg filter", () => {
  const args = ffmpegEncoderArgs({
    width: 427,
    height: 960,
    fps: 30,
    bitRate: 4_000_000,
    keyFrameInterval: 1,
    canvas: { ...LAYOUT.canvas, content: OUTER.contentRect },
  });
  expect(args[args.indexOf("-vf") + 1]).toBe(
    "crop=trunc(iw/2)*2:trunc(ih/2)*2,scale=426:960,pad=926:960:250:0:black",
  );
});

test("counts the recording's keyframe interval in real time as well as in frames", () => {
  const options = {
    width: 427,
    height: 960,
    fps: 60,
    bitRate: 4_000_000,
    keyFrameInterval: 1,
    canvas: { ...LAYOUT.canvas, content: OUTER.contentRect },
  };
  const args = ffmpegEncoderArgs({ ...options, timedKeyFrames: true });
  expect(args[args.indexOf("-vf") + 1]).toBe(
    "settb=AVTB,setpts='if(isnan(PREV_OUTPTS),0,max(RTCTIME-RTCSTART,PREV_OUTPTS+1))'," +
      "crop=trunc(iw/2)*2:trunc(ih/2)*2,scale=426:960,pad=926:960:250:0:black",
  );
  const timed = args.indexOf("-fps_mode");
  expect(args.slice(timed, timed + 6)).toEqual([
    "-fps_mode",
    "passthrough",
    "-enc_time_base",
    "1:1000000",
    "-force_key_frames",
    // One second, less half a frame of timing jitter.
    "expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+0.991667))",
  ]);
  // 60 frames is the other limit, as serve-sim's recorder.
  expect(args).toContain("keyint=60:min-keyint=60:scenecut=0:repeat-headers=1:aud=1");
  // Without it, the command line stays as it was.
  const frameCounted = ffmpegEncoderArgs(options);
  expect(frameCounted).not.toContain("-fps_mode");
  expect(frameCounted[frameCounted.indexOf("-vf") + 1]).toStartWith("crop=");
  expect(() =>
    ffmpegEncoderArgs({ ...options, timedKeyFrames: true, encoderName: "h264_videotoolbox" }),
  ).toThrow("timed keyframes need the libx264 encoder");
  expect(() =>
    ffmpegEncoderArgs({ ...options, timedKeyFrames: true, keyFrameInterval: 0 }),
  ).toThrow("timed keyframes need a positive keyFrameInterval");
});

test("asks ffmpeg once whether it knows the timed keyframe options", async () => {
  const calls: string[][] = [];
  let status: number | null = 0;
  const probe = createTimedKeyFrameProbe({
    resolveBinary: () => "ffmpeg-test",
    runExec: async (_binary, args) => {
      calls.push(args);
      return { status, stdout: "", stderr: "", timedOut: false, error: null } as never;
    },
  });
  expect(await probe()).toBe(true);
  expect(await probe()).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("-fps_mode");
  // ffmpeg older than 5.1 rejects -fps_mode; the answer is kept too.
  status = 8;
  const old = createTimedKeyFrameProbe({
    resolveBinary: () => "ffmpeg-old",
    runExec: async () =>
      ({ status, stdout: "", stderr: "", timedOut: false, error: null }) as never,
  });
  expect(await old()).toBe(false);
  // A probe that could not run is asked again.
  let runs = 0;
  const flaky = createTimedKeyFrameProbe({
    resolveBinary: () => "ffmpeg-flaky",
    runExec: async () => {
      runs++;
      return { status: null, stdout: "", stderr: "", timedOut: true, error: null } as never;
    },
  });
  expect(await flaky()).toBe(false);
  expect(await flaky()).toBe(false);
  expect(runs).toBe(2);
});

const config = Buffer.from(
  "000000016742c01fd9005005bb0110000003001000000303c0f18324800000000168cb83cb20",
  "hex",
);
const key = Buffer.concat([config, Buffer.from("0000000165888421", "hex")]);
const delta = Buffer.from("00000001419a13", "hex");
const frame = (pts: bigint, data = key, isKey = true): VideoFrame => ({
  type: "frame",
  pts,
  data,
  isKey,
  isConfig: false,
});

async function recorder(options: { realWriter?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "recording-fold-test-"));
  roots.push(root);
  let nowUs = 0n;
  let persistedUntil: number | undefined;
  const recording = await ScreenRecording.create({
    directory: join(root, "session"),
    udid: "emulator-5554",
    deviceName: "Pixel_9_Pro_Fold",
    runtimeDisplayName: "Android 16",
    clock: { monotonicUs: () => nowUs, epochMs: () => 1_800_000_000_000 },
    ...(options.realWriter
      ? {}
      : {
          createWriter: async ({ path }) => {
            await writeFile(path, "test-writer");
            return {
              add: async () => {},
              finish: async () => {},
              cancel: async () => {},
              persistedUntil: () => persistedUntil ?? Number.POSITIVE_INFINITY,
            };
          },
        }),
  });
  const path = join(root, "session", "session.json");
  const manifest = async () => JSON.parse(await readFile(path, "utf8"));
  /** The manifest once `check` accepts it; manifests are written in the background. */
  const manifestWhen = async (check: (value: Record<string, unknown>) => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = await manifest().catch(() => null);
      if (value && check(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return manifest();
  };
  return {
    recording,
    manifest,
    manifestWhen,
    root,
    setTime: (value: bigint) => {
      nowUs = value;
    },
    setPersistedUntil: (seconds: number) => {
      persistedUntil = seconds;
    },
  };
}

test("keeps one track through a fold and writes the display timeline", async () => {
  const { recording, manifest } = await recorder();
  recording.followFold();
  recording.foldCanvas(LAYOUT);
  expect(recording.snapshot()).toEqual({ status: "waiting", followsFold: true });
  recording.observePose({ hingeAngle: 180, orientation: "portrait" });
  recording.accept(frame(1_000_000n), LAYOUT.canvas, "grpc-screenshot", INNER);
  await recording.ready;
  expect(recording.snapshot()).toMatchObject({ status: "recording", followsFold: true });
  recording.accept(frame(1_100_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", INNER);
  // The cover display shows before the hinge reading catches up: the hinge is unknown.
  recording.accept(frame(3_000_000n), LAYOUT.canvas, "grpc-screenshot", OUTER);
  recording.observePose({ hingeAngle: 0 });
  recording.accept(frame(3_500_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", OUTER);
  // A hinge-only change within 250 ms of the previous entry waits for a later frame.
  recording.observePose({ hingeAngle: 10 });
  recording.accept(frame(3_600_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", OUTER);
  recording.accept(frame(3_700_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", OUTER);
  // A turn of the UI is a layout change, so it does not wait.
  recording.observePose({ orientation: "landscape_left" });
  recording.accept(frame(3_800_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", OUTER);
  recording.observePose({ hingeAngle: 180 });
  recording.accept(frame(5_000_000n), LAYOUT.canvas, "grpc-screenshot", INNER);
  recording.observePose({ hingeAngle: 90 });
  recording.accept(frame(5_100_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", INNER);
  await recording.finish();
  const result = await manifest();
  expect(result).toMatchObject({ status: "complete", width: 926, height: 960 });
  const pose = (entry: { state: Record<string, unknown> }) => ({
    screen: entry.state.screen,
    hingeAngle: entry.state.hingeAngle,
    orientation: entry.state.orientation,
  });
  expect(
    result.deviceStates.map((entry: { timeMs: number; state: Record<string, unknown> }) => ({
      timeMs: entry.timeMs,
      ...pose(entry),
    })),
  ).toEqual([
    { timeMs: 0, screen: "inner", hingeAngle: 180, orientation: "portrait" },
    { timeMs: 2000, screen: "outer", hingeAngle: undefined, orientation: "portrait" },
    { timeMs: 2500, screen: "outer", hingeAngle: 0, orientation: "portrait" },
    { timeMs: 2800, screen: "outer", hingeAngle: 10, orientation: "landscape_left" },
    { timeMs: 4000, screen: "inner", hingeAngle: 180, orientation: "landscape_left" },
    // The final written state stays, although it is within 250 ms of the previous entry.
    { timeMs: 4100, screen: "inner", hingeAngle: 90, orientation: "landscape_left" },
  ]);
  // The hinge angle holds the posture, so the timeline does not repeat it.
  for (const entry of result.deviceStates) expect(entry.state).not.toHaveProperty("posture");
  expect(result.deviceStates[1].state.contentRect).toEqual({
    x: 250,
    y: 0,
    width: 426,
    height: 960,
  });
});

test("a frame shows the hinge reading from before it was captured", async () => {
  const { recording, manifest, setTime } = await recorder();
  setTime(900_000n);
  recording.observePose({ hingeAngle: 180 });
  recording.accept(frame(1_000_000n), LAYOUT.canvas, "grpc-screenshot", INNER);
  await recording.ready;
  // A reading after the next frame's capture, but before ffmpeg returns that frame.
  setTime(1_200_000n);
  recording.observePose({ hingeAngle: 90 });
  recording.accept(frame(1_100_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", INNER);
  recording.accept(frame(1_500_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", INNER);
  setTime(2_000_000n);
  await recording.finish();
  const states = (await manifest()).deviceStates;
  expect(
    states.map((entry: { timeMs: number; state: { hingeAngle: number } }) => [
      entry.timeMs,
      entry.state.hingeAngle,
    ]),
  ).toEqual([
    [0, 180],
    [500, 90],
  ]);
});

test("a partial manifest lists only the timeline of the frames in finished fragments", async () => {
  const { recording, manifestWhen, setPersistedUntil } = await recorder();
  setPersistedUntil(0);
  recording.accept(frame(1_000_000n), LAYOUT.canvas, "grpc-screenshot", INNER);
  await recording.ready;
  recording.accept(frame(3_000_000n), LAYOUT.canvas, "grpc-screenshot", OUTER);
  recording.accept(frame(5_000_000n), LAYOUT.canvas, "grpc-screenshot", INNER);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(
    (await manifestWhen((value) => value.status === "recording")).deviceStates,
  ).toBeUndefined();
  // The fragment before the 2 s frame finished: only its entry is in the file.
  setPersistedUntil(2);
  recording.accept(frame(5_100_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", INNER);
  const partial = await manifestWhen((value) => Array.isArray(value.deviceStates));
  expect(partial.deviceStates.map((entry: { timeMs: number }) => entry.timeMs)).toEqual([0]);
  await recording.finish();
  const complete = await manifestWhen((value) => value.status === "complete");
  expect(complete.deviceStates.map((entry: { timeMs: number }) => entry.timeMs)).toEqual([
    0, 2000, 4000,
  ]);
});

test("a fold keyframe just after a fragment boundary stays out of the partial timeline", async () => {
  const { recording, manifestWhen, setPersistedUntil } = await recorder();
  setPersistedUntil(0);
  recording.accept(frame(1_000_000n), LAYOUT.canvas, "grpc-screenshot", INNER);
  await recording.ready;
  // The fold starts a fragment at 2.0004 s; its entry's rounded `timeMs` is 2000.
  recording.accept(frame(3_000_400n), LAYOUT.canvas, "grpc-screenshot", OUTER);
  recording.accept(frame(3_100_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", OUTER);
  setPersistedUntil(Number(2_000_400n) / 1e6);
  recording.accept(frame(3_200_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", OUTER);
  const partial = await manifestWhen((value) => Array.isArray(value.deviceStates));
  expect(partial.deviceStates.map((entry: { timeMs: number }) => entry.timeMs)).toEqual([0]);
  await recording.finish();
  const complete = await manifestWhen((value) => value.status === "complete");
  expect(complete.deviceStates.map((entry: { timeMs: number }) => entry.timeMs)).toEqual([0, 2000]);
  expect(complete.deviceStates[1]).not.toHaveProperty("atSeconds");
});

test("the MP4 writer reports the frames in its finished fragments", async () => {
  const { recording, root, manifestWhen } = await recorder({ realWriter: true });
  recording.accept(frame(1_000_000n), LAYOUT.canvas, "grpc-screenshot", INNER);
  await recording.ready;
  recording.accept(frame(1_500_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", INNER);
  // A keyframe after mediabunny's 1 s minimum fragment finishes the first fragment.
  recording.accept(frame(2_500_000n), LAYOUT.canvas, "grpc-screenshot", OUTER);
  recording.accept(frame(2_600_000n, delta, false), LAYOUT.canvas, "grpc-screenshot", OUTER);
  const partial = await manifestWhen((value) => Array.isArray(value.deviceStates));
  expect(partial.status).toBe("recording");
  expect(partial.deviceStates.map((entry: { timeMs: number }) => entry.timeMs)).toEqual([0]);
  const file = await readFile(join(root, "session", "recording.mp4.partial"));
  expect(file.length).toBeGreaterThan(28);
  await recording.finish();
});

test("a recording without fold geometry writes no timeline", async () => {
  const { recording, manifest } = await recorder();
  recording.accept(frame(1_000_000n), { width: 1080, height: 2400 }, "grpc-screenshot");
  await recording.ready;
  expect(recording.snapshot()).not.toHaveProperty("followsFold");
  recording.accept(frame(1_100_000n, delta, false), { width: 1080, height: 2400 }, "scrcpy");
  await recording.finish();
  expect(await manifest()).not.toHaveProperty("deviceStates");
});

type FakeEncoder = {
  options: H264EncoderOpts;
  writes: bigint[];
  writable: boolean;
  closed: boolean;
};

function fakeEncoders() {
  let recording = true;
  const encoders: FakeEncoder[] = [];
  const accepted: Array<{ pts: bigint; geometry: RecordingGeometry }> = [];
  const failures: Error[] = [];
  const output: GrpcRecordingOutput = {
    ...LAYOUT,
    accept: (packet, geometry) =>
      accepted.push({ pts: packet.type === "frame" ? packet.pts : -1n, geometry }),
    fail: (error) => failures.push(error),
    active: () => recording,
  };
  const encoder = new GrpcRecordingEncoder({
    output,
    fps: 30,
    bitRate: 4_000_000,
    timedKeyFrames: true,
    inputFormat: "rgb24",
    createEncoder: (options) => {
      const fake: FakeEncoder = { options, writes: [], writable: true, closed: false };
      encoders.push(fake);
      return {
        get writable() {
          return fake.writable;
        },
        write: (_image, ptsUs) => {
          fake.writes.push(ptsUs);
          return true;
        },
        close: async () => {
          fake.closed = true;
        },
      };
    },
  });
  return {
    encoder,
    encoders,
    accepted,
    failures,
    endRecording: () => {
      recording = false;
    },
  };
}

const image = (width: number, height: number) => ({ image: Buffer.alloc(0), width, height });

test("starts a canvas encoder per display size, and drops a replaced encoder's output", async () => {
  const { encoder, encoders, accepted, failures } = fakeEncoders();
  encoder.write(image(926, 960), 1n);
  encoder.write(image(926, 960), 2n);
  expect(encoders).toHaveLength(1);
  expect(encoders[0]!.options).toMatchObject({
    encoderName: "libx264",
    keyFrameInterval: 1,
    timedKeyFrames: true,
    width: 926,
    height: 960,
    canvas: { width: 926, height: 960, content: { x: 0, y: 0, width: 926, height: 960 } },
  });
  encoders[0]!.options.onFrame(frame(1n));
  encoder.write(image(427, 960), 3n);
  expect(encoders).toHaveLength(2);
  expect(encoders[0]!.closed).toBe(true);
  expect(encoders[1]!.options.canvas).toEqual({
    width: 926,
    height: 960,
    content: { x: 250, y: 0, width: 426, height: 960 },
  });
  // The first encoder flushes an older frame after the switch; the recording never sees it.
  encoders[0]!.options.onFrame(frame(2n));
  encoders[1]!.options.onFrame(frame(3n));
  expect(accepted.map(({ pts, geometry }) => [pts, geometry.screen])).toEqual([
    [1n, "inner"],
    [3n, "outer"],
  ]);
  // A busy encoder skips the frame instead of queueing it.
  encoders[1]!.writable = false;
  encoder.write(image(427, 960), 4n);
  expect(encoders[1]!.writes).toEqual([3n]);
  encoders[0]!.options.onExit("retired exit");
  expect(failures).toEqual([]);
  encoders[1]!.options.onExit("boom");
  expect(failures.map((error) => error.message)).toEqual(["Recording encoder failed: boom"]);
  encoder.write(image(926, 960), 5n);
  expect(encoders).toHaveLength(2);
  await encoder.close();
  expect(encoders.every((fake) => fake.closed)).toBe(true);
});

test("stops encoding once the recording ends", async () => {
  const { encoder, encoders, endRecording } = fakeEncoders();
  encoder.write(image(926, 960), 1n);
  endRecording();
  encoder.write(image(926, 960), 2n);
  encoder.write(image(427, 960), 3n);
  await encoder.close();
  expect(encoders).toHaveLength(1);
  expect(encoders[0]!.writes).toEqual([1n]);
  expect(encoders[0]!.closed).toBe(true);
});
