import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from "mediabunny";
import {
  ScreenRecording,
  type RecordingOptions,
  type RecordingWriter,
} from "../src/screen-recording.ts";
import type { VideoFrame } from "../src/scrcpy.ts";
import { createRecordingFileTarget } from "../src/recording-file-target.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const config = Buffer.from(
  "000000016742c01fd9005005bb0110000003001000000303c0f18324800000000168cb83cb20",
  "hex",
);
const key = Buffer.concat([config, Buffer.from("0000000165888421", "hex")]);
const delta = Buffer.from("00000001419a13", "hex");
const size = { width: 1280, height: 720 };
const frame = (pts: bigint, data = key, isKey = true): VideoFrame => ({
  type: "frame",
  pts,
  data,
  isKey,
  isConfig: false,
});

async function setup(extra: Partial<RecordingOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "screen-recording-test-"));
  roots.push(root);
  let nowUs = 10_000_000n;
  const samples: Parameters<RecordingWriter["add"]>[0][] = [];
  let cancelled = false;
  const recording = await ScreenRecording.create({
    directory: join(root, "session"),
    udid: "emulator-5554",
    deviceName: "Pixel",
    runtimeDisplayName: "Android 16",
    clock: { monotonicUs: () => nowUs, epochMs: () => 1_800_000_000_000 },
    createWriter: async ({ path }) => {
      await writeFile(path, "test-writer");
      return {
        add: async (sample) => {
          samples.push(sample);
        },
        finish: async () => {},
        cancel: async () => {
          cancelled = true;
        },
      };
    },
    ...extra,
  });
  return {
    recording,
    root,
    samples,
    setTime: (value: bigint) => {
      nowUs = value;
    },
    cancelled: () => cancelled,
  };
}

test("preserves large source PTS deltas, long idle gaps and the final idle tail", async () => {
  const { recording, samples, root, setTime } = await setup();
  const origin = 9_007_199_254_740_999n;
  recording.accept(frame(origin, delta, false), size, "scrcpy");
  expect(recording.snapshot()).toEqual({ status: "waiting" });
  recording.accept(frame(origin), size, "scrcpy");
  await recording.ready;
  recording.accept(frame(origin + 2_500_000n, delta, false), size, "scrcpy");
  recording.accept(frame(origin + 12_500_000n), size, "scrcpy");
  setTime(30_000_000n);
  const finishing = recording.finish();
  expect(recording.finish()).toBe(finishing);
  await finishing;
  expect(samples.map(({ timestamp, duration }) => [timestamp, duration])).toEqual([
    [0, 2.5],
    [2.5, 10],
    [12.5, 7.5],
  ]);
  const manifest = JSON.parse(await readFile(join(root, "session/session.json"), "utf8"));
  expect(manifest).toMatchObject({
    status: "complete",
    recording: "recording.mp4",
    firstFrameWallClock: { iso8601: new Date(1_800_000_000_000).toISOString() },
    width: 1280,
    height: 720,
    durationSeconds: 20,
  });
});

test("gRPC firstFrameAt accounts for encoder and read latency using its host PTS", async () => {
  const { recording, root, setTime } = await setup();
  recording.accept(frame(9_750_000n), size, "grpc-screenshot");
  await recording.ready;
  setTime(11_000_000n);
  await recording.finish();
  const manifest = JSON.parse(await readFile(join(root, "session/session.json"), "utf8"));
  expect(manifest).toMatchObject({
    firstFrameWallClock: { iso8601: new Date(1_800_000_000_000 - 250).toISOString() },
    durationSeconds: 1.25,
  });
});

test.each(["clock", "pts"])(
  "finishes at the duration limit using %s without another writer",
  async (kind) => {
    const { recording, samples, root } = await setup({ maxDurationMs: 30 });
    recording.accept(frame(0n), size, "scrcpy");
    await recording.ready;
    if (kind === "clock") {
      await Bun.sleep(60);
    } else {
      recording.accept(frame(30_000n, delta, false), size, "scrcpy");
    }
    await recording.finish();
    expect(samples).toHaveLength(1);
    expect(samples[0].duration).toBe(0.03);
    expect(recording.active).toBe(false);
    expect(() => recording.accept(frame(40_000n), size, "scrcpy")).not.toThrow();
    expect(JSON.parse(await readFile(join(root, "session/session.json"), "utf8"))).toMatchObject({
      status: "complete",
      stopReason: "duration-limit",
      durationSeconds: 0.03,
    });
  },
);

test.each([
  { maxFileBytes: 0 },
  { maxFileBytes: NaN },
  { maxDurationMs: 0 },
  { maxDurationMs: 86_400_001 },
  { minFreeBytes: -1 },
  { minFreeBytes: 1.5 },
])("rejects invalid recording limits %j", async (limits) => {
  await expect(setup(limits)).rejects.toThrow("Invalid recording limit");
});

test("rejects low free space before opening the output", async () => {
  const { root } = await setup();
  const path = join(root, "guarded.mp4");
  await expect(
    createRecordingFileTarget({
      path,
      maxFileBytes: 1024,
      minFreeBytes: 100,
      readFreeBytes: async () => 99,
    }),
  ).rejects.toThrow("free-space reserve");
  expect(await Bun.file(path).exists()).toBe(false);
});

test("accounts for file growth between free-space probes", async () => {
  const { root } = await setup();
  const path = join(root, "guarded.mp4");
  const file = await createRecordingFileTarget({
    path,
    maxFileBytes: 1024 * 1024,
    minFreeBytes: 100,
    readFreeBytes: async () => 200,
  });
  const source = new EncodedVideoPacketSource("avc");
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: file.target,
  });
  output.addVideoTrack(source);
  await output.start();
  await source.add(new EncodedPacket(key, "key", 0, 1), {
    decoderConfig: { codec: "avc1.42c01f", codedWidth: size.width, codedHeight: size.height },
  });
  await expect(output.finalize()).rejects.toThrow("free-space reserve");
  await file.close();
  expect((await stat(path)).size).toBeLessThanOrEqual(100);
});

test.each(["bytes", "space"])(
  "enforces the %s limit during actual MP4 finalization",
  async (kind) => {
    const { recording, root } = await setup({
      createWriter: undefined,
      maxFileBytes: kind === "bytes" ? 128 : undefined,
      minFreeBytes: kind === "space" ? Number.MAX_SAFE_INTEGER : 0,
    });
    recording.accept(frame(0n), size, "scrcpy");
    if (kind === "space") await expect(recording.ready).rejects.toThrow("free-space reserve");
    else await recording.ready;
    await expect(recording.finish()).rejects.toThrow(
      kind === "bytes" ? "byte limit" : "free-space reserve",
    );
    expect(() => recording.accept(frame(30_000n), size, "scrcpy")).not.toThrow();
    expect(await Bun.file(join(root, "session/recording.mp4")).exists()).toBe(false);
    expect(JSON.parse(await readFile(join(root, "session/session.json"), "utf8"))).toMatchObject({
      status: "failed",
    });
    if (kind === "bytes")
      expect((await stat(join(root, "session/recording.mp4.partial"))).size).toBeLessThanOrEqual(
        128,
      );
  },
);

test("does not publish a recording without a keyframe", async () => {
  const { recording, root } = await setup();
  recording.accept(frame(0n, delta, false), size, "scrcpy");
  await expect(recording.finish()).rejects.toThrow("no decodable frame");
  expect(await Bun.file(join(root, "session/recording.mp4")).exists()).toBe(false);
});

test.each(["size", "config", "timestamp"])(
  "reports %s discontinuity and leaves preview callers usable",
  async (kind) => {
    const { recording, root } = await setup();
    recording.accept(frame(10n), size, "scrcpy");
    await recording.ready;
    if (kind === "size")
      recording.accept(
        { type: "session", width: 720, height: 1280, clientResized: false },
        size,
        "scrcpy",
      );
    if (kind === "config") {
      const changed = Buffer.from(key);
      changed[7] ^= 1;
      recording.accept(frame(20n, changed), size, "scrcpy");
    }
    if (kind === "timestamp") recording.accept(frame(9n), size, "scrcpy");
    expect(recording.snapshot().status).toBe("failed");
    expect(() => recording.accept(frame(30n), size, "scrcpy")).not.toThrow();
    await expect(recording.finish()).rejects.toThrow();
    expect(await Bun.file(join(root, "session/recording.mp4")).exists()).toBe(false);
  },
);

test("bounds a stalled writer without blocking packet delivery", async () => {
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { recording } = await setup({
    maxQueuedBytes: 256,
    createWriter: async () => ({
      add: () => blocked,
      finish: async () => {},
      cancel: async () => {},
    }),
  });
  recording.accept(frame(0n), size, "scrcpy");
  await recording.ready;
  for (let i = 1; i <= 100; i++) recording.accept(frame(BigInt(i * 1000)), size, "scrcpy");
  expect(recording.snapshot()).toMatchObject({
    status: "failed",
    error: expect.stringContaining("byte limit"),
  });
  release();
  await expect(recording.finish()).rejects.toThrow("byte limit");
});

test("rejects an oversized first frame and persists a failed manifest", async () => {
  const { recording, root, cancelled } = await setup({ maxQueuedBytes: 16 });
  recording.accept(frame(0n), size, "scrcpy");
  await expect(recording.ready).rejects.toThrow("byte limit");
  await expect(recording.finish()).rejects.toThrow("byte limit");
  expect(cancelled()).toBe(true);
  expect(JSON.parse(await readFile(join(root, "session/session.json"), "utf8"))).toMatchObject({
    status: "failed",
  });
});

test.each(["start", "write", "finish"])(
  "does not publish after a writer %s failure",
  async (phase) => {
    const error = new Error("disk unavailable");
    const { recording, root } = await setup({
      createWriter: async () => {
        if (phase === "start") throw error;
        return {
          add: async () => {
            if (phase === "write") throw error;
          },
          finish: async () => {
            if (phase === "finish") throw error;
          },
          cancel: async () => {},
        };
      },
    });
    recording.accept(frame(0n), size, "scrcpy");
    if (phase === "start") await expect(recording.ready).rejects.toThrow("disk unavailable");
    else await recording.ready;
    await expect(recording.finish()).rejects.toThrow("disk unavailable");
    const manifest = JSON.parse(await readFile(join(root, "session/session.json"), "utf8"));
    expect(manifest.status).toBe("failed");
    expect(manifest.recording).toBeUndefined();
  },
);

test("a capture failure during finalization cannot publish a complete result", async () => {
  const finishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { recording, root } = await setup({
    createWriter: async () => ({
      add: async () => {},
      finish: async () => {
        finishing.resolve();
        await release.promise;
      },
      cancel: async () => {},
    }),
  });
  recording.accept(frame(0n), size, "scrcpy");
  await recording.ready;
  const result = recording.finish();
  await finishing.promise;
  recording.fail(new Error("capture ended"));
  release.resolve();
  await expect(result).rejects.toThrow("capture ended");
  expect(JSON.parse(await readFile(join(root, "session/session.json"), "utf8"))).toMatchObject({
    status: "failed",
  });
});

function encodeFixtureFrame() {
  return execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=128x96:r=1",
    "-frames:v",
    "1",
    "-c:v",
    "libx264",
    "-profile:v",
    "baseline",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "h264",
    "pipe:1",
  ]);
}

function probePacketTimings(file: string): number[][] {
  return execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(",").map(Number));
}

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "a recording cut off before finish still decodes the fragments already on disk",
  async () => {
    const { root } = await setup();
    const encoded = encodeFixtureFrame();
    const directory = join(root, "cut");
    const recording = await ScreenRecording.create({
      directory,
      udid: "emulator-5554",
      deviceName: "fixture",
      runtimeDisplayName: "Android",
      clock: { monotonicUs: () => 0n, epochMs: () => 1_800_000_000_000 },
    });
    // Each frame is 1 s apart, so every accepted frame closes the previous fragment.
    for (let second = 0; second < 4; second++) {
      recording.accept(frame(BigInt(second) * 1_000_000n, encoded), { width: 128, height: 96 }, "scrcpy");
      if (second === 0) await recording.ready;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const partial = join(directory, "recording.mp4.partial");
    expect(probePacketTimings(partial).map(([pts]) => pts)).toEqual([0, 1]);
    expect(() =>
      execFileSync("ffmpeg", ["-v", "error", "-i", partial, "-f", "null", "-"]),
    ).not.toThrow();
    recording.fail(new Error("simulated crash"));
  },
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "writes a decodable MP4 with independently verified packet timestamps",
  async () => {
    const { root } = await setup();
    const encoded = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=128x96:r=1",
      "-frames:v",
      "1",
      "-c:v",
      "libx264",
      "-profile:v",
      "baseline",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "h264",
      "pipe:1",
    ]);
    let time = 0n;
    const directory = join(root, "real");
    const recording = await ScreenRecording.create({
      directory,
      udid: "emulator-5554",
      deviceName: "fixture",
      runtimeDisplayName: "Android",
      clock: { monotonicUs: () => time, epochMs: () => 1_800_000_000_000 },
    });
    recording.accept(frame(0n, encoded), { width: 128, height: 96 }, "scrcpy");
    await recording.ready;
    recording.accept(frame(2_500_000n, encoded), { width: 128, height: 96 }, "scrcpy");
    recording.accept(frame(12_500_000n, encoded), { width: 128, height: 96 }, "scrcpy");
    time = 20_000_000n;
    await recording.finish();
    const mp4 = join(directory, "recording.mp4");
    expect(probePacketTimings(mp4).map(([pts]) => pts)).toEqual([0, 2.5, 12.5]);
    // Sample durations live in each fragment's tfhd; ffprobe reports them only as the total duration.
    const duration = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4],
      { encoding: "utf8" },
    ).trim();
    expect(Number(duration)).toBe(20);
    expect(() =>
      execFileSync("ffmpeg", ["-v", "error", "-i", mp4, "-f", "null", "-"]),
    ).not.toThrow();
  },
);
