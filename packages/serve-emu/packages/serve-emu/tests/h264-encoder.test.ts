import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import {
  createFfmpegAvailabilityProbe,
  createFfmpegEncoderResolver,
  ffmpegEncoderArgs,
  runFfmpegSmokeEncode,
  FfmpegStderrTail,
  ffmpegInputArgs,
  H264Encoder,
  H264OutputParser,
  resolveFfmpeg,
  videoFilter,
  type H264EncoderOpts,
  type FfmpegEncoderName,
} from "../src/h264-encoder.ts";
import { ExecError, getExecSnapshot, type ExecResult } from "../src/exec.ts";
import type { VideoFrame } from "../src/scrcpy.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function execResult(
  overrides: Partial<ExecResult<string>> = {},
): ExecResult<string> {
  return {
    status: 0,
    signal: null,
    stdout: " V..... libx264 H.264 / AVC / MPEG-4 AVC",
    stderr: "",
    timedOut: false,
    error: null,
    ...overrides,
  };
}

function hasFfmpegWithLibx264(): boolean {
  const result = spawnSync(resolveFfmpeg(), ["-hide_banner", "-encoders"], {
    encoding: "utf8",
  });
  return (
    result.status === 0 &&
    /\blibx264\b/.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)
  );
}

const realFfmpegTest = hasFfmpegWithLibx264() ? test : test.skip;
const hostResolver = createFfmpegEncoderResolver();
const hostHardwareEncoder = await hostResolver.resolveEncoder("hardware").catch(() => null);
const realHardwareTest = hostHardwareEncoder ? test : test.skip;

function nal(
  typeByte: number,
  payload: number[] = [],
  startCodeBytes: 3 | 4 = 4,
): Buffer {
  const start = startCodeBytes === 3 ? [0, 0, 1] : [0, 0, 0, 1];
  return Buffer.from([...start, typeByte, ...payload]);
}

function aud(startCodeBytes: 3 | 4 = 4): Buffer {
  return nal(0x09, [0xf0], startCodeBytes);
}

function pushInUnevenChunks(parser: H264OutputParser, stream: Buffer): void {
  const widths = [1, 2, 7, 3, 11, 5];
  let offset = 0;
  let index = 0;
  while (offset < stream.length) {
    const end = Math.min(
      stream.length,
      offset + widths[index % widths.length]!,
    );
    parser.push(stream.subarray(offset, end));
    offset = end;
    index++;
  }
}

describe("H264OutputParser", () => {
  test("emits current VideoFrame objects across split and mixed Annex-B start codes", () => {
    const frames: VideoFrame[] = [];
    const parser = new H264OutputParser({
      fps: 60,
      onFrame: (frame) => frames.push(frame),
    });
    parser.enqueuePts(10_000n);
    parser.enqueuePts(20_000n);

    const stream = Buffer.concat([
      aud(3),
      nal(0x67, [0x42, 0x00, 0x1f], 4),
      nal(0x68, [0xce, 0x06], 3),
      nal(0x65, [0xaa, 0xbb], 4),
      aud(4),
      nal(0x41, [0xcc], 3),
      aud(3),
    ]);
    pushInUnevenChunks(parser, stream);

    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({
      type: "frame",
      pts: 0n,
      isConfig: true,
      isKey: false,
    });
    expect(frames[1]).toMatchObject({
      type: "frame",
      pts: 10_000n,
      isConfig: false,
      isKey: true,
    });
    expect(frames[2]).toMatchObject({
      type: "frame",
      pts: 20_000n,
      isConfig: false,
      isKey: false,
    });
    expect(frames[0]!.data.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]));
    expect(frames[1]!.data.subarray(0, 5)).toEqual(
      Buffer.from([0, 0, 0, 1, 0x65]),
    );
  });

  test("does not duplicate a NAL when a chunk ends inside its four-byte start code", () => {
    const frames: VideoFrame[] = [];
    const parser = new H264OutputParser({
      fps: 60,
      onFrame: (frame) => frames.push(frame),
    });
    parser.enqueuePts(1n);

    const stream = Buffer.concat([aud(), nal(0x65, [0x01, 0x02]), aud()]);
    // Nine bytes lands immediately after the IDR start code, forcing the
    // overlap scan to encounter its embedded three-byte start code.
    parser.push(stream.subarray(0, 9));
    parser.push(stream.subarray(9));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ isKey: true, pts: 1n });
    expect(frames[0]!.data).toEqual(nal(0x65, [0x01, 0x02]));
  });

  test("holds the final access unit until the following AUD and de-duplicates config", () => {
    const frames: VideoFrame[] = [];
    const parser = new H264OutputParser({
      fps: 30,
      onFrame: (frame) => frames.push(frame),
    });
    parser.enqueuePts(1n);
    parser.enqueuePts(2n);

    const configAndIdr = [
      nal(0x67, [0x42, 0x00, 0x1f]),
      nal(0x68, [0xce, 0x06]),
      nal(0x65, [0x01]),
    ];
    parser.push(
      Buffer.concat([aud(), ...configAndIdr, aud(), ...configAndIdr]),
    );
    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.isConfig)).toEqual([true, false]);

    parser.push(aud());
    expect(frames).toHaveLength(3);
    expect(frames.filter((frame) => frame.isConfig)).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({
      pts: 2n,
      isKey: true,
      type: "frame",
    });
  });

  test("uses the configured frame duration when ffmpeg produces an unmatched access unit", () => {
    const frames: VideoFrame[] = [];
    const parser = new H264OutputParser({
      fps: 60,
      onFrame: (frame) => frames.push(frame),
    });
    parser.push(
      Buffer.concat([aud(), nal(0x41, [1]), aud(), nal(0x41, [2]), aud()]),
    );

    expect(frames.map((frame) => frame.pts)).toEqual([16_667n, 33_334n]);
  });

  test("fails bounded output with no AUD instead of silently buffering forever", () => {
    const parser = new H264OutputParser({ fps: 30, onFrame: () => {} });
    parser.push(nal(0x65));
    expect(() => parser.push(Buffer.alloc(1024 * 1024, 0xff))).toThrow(
      "without an AUD (access unit delimiter)",
    );
  });

  test("rejects invalid parser timing and timestamps", () => {
    expect(() => new H264OutputParser({ fps: 0, onFrame: () => {} })).toThrow(
      "fps must be greater than 0",
    );
    const parser = new H264OutputParser({ fps: 60, onFrame: () => {} });
    expect(() => parser.enqueuePts(-1n)).toThrow("non-negative bigint");
  });
});

describe("ffmpeg backend arguments", () => {
  const options = {
    width: 360, height: 641, fps: 30, bitRate: 8_000_000,
    keyFrameInterval: 2, quarterTurn: 1 as const,
  };

  test("preserves the complete existing software command exactly", () => {
    const expected = [
      "-hide_banner", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-video_size", "360x641",
      "-framerate", "30", "-i", "pipe:0", "-an", "-vf",
      "crop=trunc(iw/2)*2:trunc(ih/2)*2,transpose=cclock",
      "-pix_fmt", "yuv420p", "-c:v", "libx264",
      "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline",
      "-b:v", "8000000", "-maxrate", "8000000", "-bufsize", "8000000",
      "-x264-params", "keyint=60:min-keyint=60:scenecut=0:repeat-headers=1:aud=1",
      "-f", "h264", "-flush_packets", "1", "pipe:1",
    ];
    expect(ffmpegEncoderArgs(options)).toEqual(expected);
    expect(ffmpegEncoderArgs({ ...options, encoderName: "libx264" })).toEqual(expected);
    expect(ffmpegEncoderArgs({ ...options, keyFrameInterval: 0 })).toContain(
      "keyint=250:min-keyint=250:scenecut=0:repeat-headers=1:aud=1",
    );
    expect(ffmpegEncoderArgs({ ...options, inputFormat: "png" })).toEqual([
      ...expected.slice(0, 3), ...ffmpegInputArgs("png", 360, 641, 30),
      ...expected.slice(13),
    ]);
  });

  test.each([
    ["h264_videotoolbox", [
      "-pix_fmt", "nv12", "-c:v", "h264_videotoolbox",
      "-allow_sw", "0", "-realtime", "1", "-flags", "+low_delay",
      "-profile:v", "baseline",
      "-b:v", "8000000", "-maxrate", "8000000", "-bufsize", "8000000",
      "-g", "60", "-bf", "0", "-bsf:v", "h264_metadata=aud=insert",
    ]],
    ["h264_nvenc", [
      "-pix_fmt", "nv12", "-c:v", "h264_nvenc",
      "-preset", "p1", "-tune", "ull", "-zerolatency", "1",
      "-delay", "0", "-bf", "0", "-rc-lookahead", "0", "-rc", "cbr",
      "-b:v", "8000000", "-maxrate", "8000000", "-bufsize", "8000000",
      "-g", "60", "-forced-idr", "1", "-aud", "1", "-profile:v", "baseline",
    ]],
    ["h264_vaapi", [
      "-c:v", "h264_vaapi", "-rc_mode", "CBR",
      "-b:v", "8000000", "-maxrate", "8000000", "-bufsize", "8000000",
      "-g", "60", "-bf", "0", "-async_depth", "1",
      "-profile:v", "constrained_baseline", "-bsf:v", "h264_metadata=aud=insert",
    ]],
  ] as const)("builds low-delay %s with the shared geometry and Annex-B tail", (encoderName, backendArgs) => {
    const args = ffmpegEncoderArgs({ ...options, encoderName }, "/dev/dri/custom");
    expect(args).toEqual([
      "-hide_banner", "-loglevel", "error",
      ...(encoderName === "h264_vaapi"
        ? ["-init_hw_device", "vaapi=va:/dev/dri/custom", "-filter_hw_device", "va"] : []),
      ...ffmpegInputArgs("rgb24", 360, 641, 30), "-an", "-vf",
      "crop=trunc(iw/2)*2:trunc(ih/2)*2,transpose=cclock" +
        (encoderName === "h264_vaapi" ? ",format=nv12,hwupload" : ""),
      ...backendArgs, "-f", "h264", "-flush_packets", "1", "pipe:1",
    ]);
    expect(args).not.toContain("libx264");
    expect(args).not.toContain("-x264-params");
  });
});

function smokeResult(overrides: Partial<ExecResult<Buffer>> = {}): ExecResult<Buffer> {
  return {
    ...execResult(),
    stdout: Buffer.concat([aud(), nal(0x67), nal(0x68), nal(0x65), aud(), nal(0x41)]),
    ...overrides,
  };
}

const hardwareListing = () => Promise.resolve(execResult({
  stdout: "V..... libx264\nV..... h264_videotoolbox\nV..... h264_nvenc\nV..... h264_vaapi",
}));

describe("ffmpeg hardware resolver", () => {
  test("shares concurrent probes while cancelling only the departing caller", async () => {
    const completion = deferred<ExecResult<Buffer>>();
    const started = deferred<void>();
    const signals: AbortSignal[] = [];
    let listings = 0;
    const resolver = createFfmpegEncoderResolver({
      hardwareEncoder: () => "videotoolbox",
      runExec: async () => { listings++; return hardwareListing(); },
      runSmoke: (_binary, _args, _input, options) => {
        signals.push(options.signal!);
        started.resolve();
        return completion.promise;
      },
    });
    const controller = new AbortController();
    const first = resolver.resolveEncoder("hardware", controller.signal);
    const second = resolver.resolveEncoder("hardware");
    await started.promise;
    controller.abort(new Error("first device disconnected"));
    await expect(first).rejects.toThrow("first device disconnected");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    expect(listings).toBe(1);
    completion.resolve(smokeResult());
    expect(await second).toBe("h264_videotoolbox");
    expect(resolver.getHardwareEncoderError()).toBeUndefined();
  });

  test("runtime failure invalidates hardware success and allows a fresh probe", async () => {
    let calls = 0;
    const resolver = createFfmpegEncoderResolver({
      hardwareEncoder: () => "videotoolbox", runExec: hardwareListing,
      runSmoke: async () => { calls++; return smokeResult(); },
    });
    await resolver.resolveEncoder("hardware");
    resolver.reportEncoderFailure("h264_videotoolbox", "encoder exited unexpectedly");
    expect(resolver.getHardwareEncoderError()).toContain("encoder exited unexpectedly");
    await resolver.resolveEncoder("hardware");
    expect(calls).toBe(2);
    expect(resolver.getHardwareEncoderError()).toBeUndefined();
    resolver.reportEncoderFailure("libx264", "software failure");
    expect(resolver.getHardwareEncoderError()).toBeUndefined();
  });

  test("cancels a shared probe when all callers leave and isolates its late result from retries", async () => {
    const firstCompletion = deferred<ExecResult<Buffer>>();
    const retryCompletion = deferred<ExecResult<Buffer>>();
    const started = deferred<void>();
    const retryStarted = deferred<void>();
    const signals: AbortSignal[] = [];
    const resolver = createFfmpegEncoderResolver({
      hardwareEncoder: () => "videotoolbox", runExec: hardwareListing,
      runSmoke: (_binary, _args, _input, options) => {
        signals.push(options.signal!);
        if (signals.length === 1) {
          started.resolve();
          return firstCompletion.promise;
        }
        retryStarted.resolve();
        return retryCompletion.promise;
      },
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = resolver.resolveEncoder("hardware", firstController.signal);
    const second = resolver.resolveEncoder("hardware", secondController.signal);
    await started.promise;
    firstController.abort(new Error("first caller left"));
    await expect(first).rejects.toThrow("first caller left");
    expect(signals[0]!.aborted).toBe(false);
    secondController.abort(new Error("last caller left"));
    await expect(second).rejects.toThrow("last caller left");
    expect(signals[0]!.aborted).toBe(true);
    const retry = resolver.resolveEncoder("hardware");
    await retryStarted.promise;
    firstCompletion.resolve(smokeResult());
    await Promise.resolve();
    await Promise.resolve();
    const joinedRetry = resolver.resolveEncoder("hardware");
    retryCompletion.resolve(smokeResult());
    expect(await Promise.all([retry, joinedRetry])).toEqual([
      "h264_videotoolbox", "h264_videotoolbox",
    ]);
    expect(signals).toHaveLength(2);
    expect(resolver.getHardwareEncoderError()).toBeUndefined();
  });

  test("runtime failure cannot be cleared by a stale pending success", async () => {
    const completion = deferred<ExecResult<Buffer>>();
    const started = deferred<void>();
    const resolver = createFfmpegEncoderResolver({
      hardwareEncoder: () => "videotoolbox", runExec: hardwareListing,
      runSmoke: () => { started.resolve(); return completion.promise; },
    });
    const pending = resolver.resolveEncoder("hardware");
    await started.promise;
    resolver.reportEncoderFailure("h264_videotoolbox", "device lost");
    completion.resolve(smokeResult());
    await expect(pending).rejects.toThrow("device lost");
    expect(resolver.getHardwareEncoderError()).toContain("device lost");
  });

  test("software ignores hardware configuration and retains the libx264 check", async () => {
    const resolver = createFfmpegEncoderResolver({
      runExec: hardwareListing,
      hardwareEncoder: () => "invalid",
      runSmoke: async () => { throw new Error("unexpected smoke encode"); },
    });
    expect(await resolver.resolveEncoder("software")).toBe("libx264");
    expect(resolver.getHardwareEncoderError()).toBeUndefined();
  });

  test("selects VideoToolbox on macOS, passes bounded input, and caches the binary/config", async () => {
    let binary = "ffmpeg-one";
    let pin: string | undefined;
    const calls: string[] = [];
    const resolver = createFfmpegEncoderResolver({
      platform: () => "darwin", resolveBinary: () => binary,
      hardwareEncoder: () => pin, runExec: hardwareListing,
      runSmoke: async (exe, args, input, opts) => {
        calls.push(exe);
        expect(args).toContain(pin === "nvenc" ? "h264_nvenc" : "h264_videotoolbox");
        expect(input.length).toBe(256 * 256 * 3 * 4);
        expect(opts).toMatchObject({ timeout: 3_000, maxBuffer: 1024 * 1024 });
        return smokeResult();
      },
    });
    expect(await resolver.resolveEncoder("hardware")).toBe("h264_videotoolbox");
    await resolver.resolveEncoder("hardware");
    expect(calls).toHaveLength(1);
    binary = "ffmpeg-two";
    await resolver.resolveEncoder("hardware");
    pin = "nvenc";
    expect(await resolver.resolveEncoder("hardware")).toBe("h264_nvenc");
    expect(calls).toEqual(["ffmpeg-one", "ffmpeg-two", "ffmpeg-two"]);
  });

  test("probes NVENC above its Turing minimum dimensions with complete RGB frames", async () => {
    const resolver = createFfmpegEncoderResolver({
      platform: () => "linux", hardwareEncoder: () => "nvenc",
      runExec: hardwareListing,
      runSmoke: async (_binary, args, input) => {
        expect(args[args.indexOf("-c:v") + 1]).toBe("h264_nvenc");
        expect(args[args.indexOf("-video_size") + 1]).toBe("256x256");
        expect(input.length).toBe(256 * 256 * 3 * 4);
        return smokeResult();
      },
    });
    expect(await resolver.resolveEncoder("hardware")).toBe("h264_nvenc");
  });

  test("tries NVENC then VAAPI on Linux, passing the configured VAAPI device", async () => {
    const calls: string[] = [];
    const checked: string[] = [];
    const resolver = createFfmpegEncoderResolver({
      platform: () => "linux", hardwareEncoder: () => undefined,
      runExec: hardwareListing, vaapiDevice: () => "/dev/dri/renderD129",
      checkVaapiDevice: async (path) => { checked.push(path); },
      runSmoke: async (_binary, args) => {
        const name = args[args.indexOf("-c:v") + 1]!;
        calls.push(name);
        if (name === "h264_nvenc") return smokeResult({ status: 1, stderr: "Cannot load libcuda.so.1" });
        expect(args).toContain("vaapi=va:/dev/dri/renderD129");
        return smokeResult();
      },
    });
    expect(await resolver.resolveEncoder("hardware")).toBe("h264_vaapi");
    expect(calls).toEqual(["h264_nvenc", "h264_vaapi"]);
    expect(checked).toEqual(["/dev/dri/renderD129"]);
  });

  test("a pinned backend never falls back, and failed probes remain retryable", async () => {
    let fail = true;
    const calls: string[] = [];
    const resolver = createFfmpegEncoderResolver({
      platform: () => "linux", hardwareEncoder: () => "nvenc", runExec: hardwareListing,
      runSmoke: async (_binary, args) => {
        calls.push(args[args.indexOf("-c:v") + 1]!);
        return fail ? smokeResult({ status: 1, stderr: "NVIDIA driver unavailable" }) : smokeResult();
      },
    });
    await expect(resolver.resolveEncoder("hardware")).rejects.toThrow("NVIDIA driver unavailable");
    expect(resolver.getHardwareEncoderError()).toContain("h264_nvenc");
    fail = false;
    expect(await resolver.resolveEncoder("hardware")).toBe("h264_nvenc");
    expect(resolver.getHardwareEncoderError()).toBeUndefined();
    expect(calls).toEqual(["h264_nvenc", "h264_nvenc"]);
  });

  test("a changed VAAPI device requires a new probe and scopes its failure", async () => {
    let device = "/dev/dri/renderD128";
    const resolver = createFfmpegEncoderResolver({
      hardwareEncoder: () => "vaapi", vaapiDevice: () => device,
      runExec: hardwareListing, runSmoke: async () => smokeResult(),
      checkVaapiDevice: async (path) => { if (path.endsWith("129")) throw new Error("EACCES"); },
    });
    expect(await resolver.resolveEncoder("hardware")).toBe("h264_vaapi");
    device = "/dev/dri/renderD129";
    await expect(resolver.resolveEncoder("hardware")).rejects.toThrow("check the render group");
    expect(resolver.getHardwareEncoderError()).toContain(device);
    device = "/dev/dri/renderD128";
    expect(resolver.getHardwareEncoderError()).toBeUndefined();
  });

  test.each(["SPS", "PPS", "IDR", "AUD boundaries"])("rejects smoke output missing %s", async (missing) => {
    const output = Buffer.concat([
      ...(missing === "AUD boundaries" ? [] : [aud()]),
      ...(missing === "SPS" ? [] : [nal(0x67)]),
      ...(missing === "PPS" ? [] : [nal(0x68)]),
      ...(missing === "IDR" ? [] : [nal(0x65)]),
      aud(),
    ]);
    const resolver = createFfmpegEncoderResolver({
      hardwareEncoder: () => "videotoolbox", runExec: hardwareListing,
      runSmoke: async () => smokeResult({ stdout: output }),
    });
    await expect(resolver.resolveEncoder("hardware")).rejects.toThrow(missing);
  });

  test("reports invalid pins, unsupported platforms and missing encoder builds", async () => {
    for (const [pin, platform, message] of [
      ["unknown", "darwin", "must be videotoolbox, nvenc, or vaapi"],
      [undefined, "win32", "not supported on win32"],
      ["nvenc", "linux", "encoder is not included"],
    ] as const) {
      const resolver = createFfmpegEncoderResolver({
        hardwareEncoder: () => pin, platform: () => platform,
        runExec: async () => execResult(),
      });
      await expect(resolver.resolveEncoder("hardware")).rejects.toThrow(message);
    }
  });

  test("retains the stderr tail and reports timeout failures", async () => {
    const resolver = createFfmpegEncoderResolver({
      hardwareEncoder: () => "videotoolbox", runExec: hardwareListing,
      runSmoke: async () => smokeResult({ status: 1, stderr: "discard" + "x".repeat(20_000) + " useful driver error" }),
    });
    await expect(resolver.resolveEncoder("hardware")).rejects.toThrow("useful driver error");
    expect(resolver.getHardwareEncoderError()).not.toContain("discard");
    const timeout = createFfmpegEncoderResolver({
      hardwareEncoder: () => "videotoolbox", runExec: hardwareListing,
      runSmoke: async () => smokeResult({ status: null, timedOut: true, error: new Error("deadline") }),
    });
    await expect(timeout.resolveEncoder("hardware")).rejects.toThrow("timed out after 3000ms");
  });

  test("cancels before and during probing without caching a hardware failure", async () => {
    let calls = 0;
    const resolver = createFfmpegEncoderResolver({
      hardwareEncoder: () => "videotoolbox", runExec: hardwareListing,
      runSmoke: async (_binary, _args, _input, options) => {
        calls++;
        if (calls === 1) await new Promise<void>((resolve) => {
          options.signal!.addEventListener("abort", () => resolve(), { once: true });
        });
        return smokeResult();
      },
    });
    const controller = new AbortController();
    const reason = new Error("capture cancelled");
    const active = resolver.resolveEncoder("hardware", controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(reason);
    await expect(active).rejects.toBe(reason);
    expect(resolver.getHardwareEncoderError()).toBeUndefined();
    await expect(resolver.resolveEncoder("hardware", controller.signal)).rejects.toBe(reason);
    expect(await resolver.resolveEncoder("hardware")).toBe("h264_videotoolbox");
    expect(calls).toBe(2);
  });

  realFfmpegTest("the host provides a working hardware encoder or an actionable strict failure", () => {
    if (hostHardwareEncoder) expect(hostHardwareEncoder).toMatch(/^h264_(videotoolbox|nvenc|vaapi)$/);
    else expect(hostResolver.getHardwareEncoderError()).toContain("Hardware H.264 encoder unavailable");
  });
});

describe("smoke subprocess bounds", () => {
  test("uses executor background accounting and the effective default deadline", async () => {
    const started = getExecSnapshot().totals.started;
    const pending = runFfmpegSmokeEncode(process.execPath,
      ["-e", "setInterval(() => {}, 1000)"], Buffer.alloc(0), { lane: "background" });
    expect(getExecSnapshot().lanes.background.active).toBeGreaterThan(0);
    const result = await pending;
    expect(getExecSnapshot().totals.started).toBe(started + 1);
    expect(result.timedOut).toBe(true);
    expect(result.error?.message).toContain("3000ms");
  });

  test("kills an encode that exceeds its timeout", async () => {
    const start = Date.now();
    const result = await runFfmpegSmokeEncode(process.execPath,
      ["-e", "setInterval(() => {}, 1000)"], Buffer.alloc(0), { timeout: 30 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(1_500);
  });

  test("terminates an aborted encode", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel test encode");
    const pending = runFfmpegSmokeEncode(process.execPath,
      ["-e", "setInterval(() => {}, 1000)"], Buffer.alloc(0), { timeout: 1000, signal: controller.signal });
    controller.abort(reason);
    const error = (await pending).error;
    expect(error).toBeInstanceOf(ExecError);
    expect(error?.cause).toBe(reason);
  });

  test("limits subprocess output", async () => {
    const result = await runFfmpegSmokeEncode(process.execPath,
      ["-e", "process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1000)"],
      Buffer.alloc(0), { timeout: 1000, maxBuffer: 100 });
    expect(result.error).toMatchObject({ code: "output-limit" });
    expect(result.stdout.length).toBeLessThanOrEqual(100);
  });
});

describe("ffmpeg availability probe", () => {
  test("runs asynchronously in the background and caches a successful binary", async () => {
    const completion = deferred<ExecResult<string>>();
    const calls: Array<{
      binary: string;
      args: string[];
      options: Record<string, unknown>;
    }> = [];
    const probe = createFfmpegAvailabilityProbe({
      resolveBinary: () => "test-ffmpeg",
      runExec: (binary, args, options) => {
        calls.push({ binary, args, options });
        return completion.promise;
      },
    });

    let settled = false;
    const first = probe().finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls).toEqual([
      {
        binary: "test-ffmpeg",
        args: ["-hide_banner", "-encoders"],
        options: {
          timeout: 10_000,
          maxBuffer: 8 * 1024 * 1024,
          signal: undefined,
          lane: "background",
        },
      },
    ]);

    completion.resolve(execResult());
    await first;
    await probe();
    expect(calls).toHaveLength(1);
  });

  test("passes cancellation to the process and does not cache an aborted probe", async () => {
    const calls: AbortSignal[] = [];
    const probe = createFfmpegAvailabilityProbe({
      resolveBinary: () => "test-ffmpeg",
      runExec: async (_binary, _args, options) => {
        const signal = options.signal!;
        calls.push(signal);
        if (calls.length > 1) return execResult();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return execResult({
          status: null,
          error: new Error("command was aborted"),
        });
      },
    });
    const controller = new AbortController();
    const reason = new Error("source switch cancelled startup");
    const first = probe(controller.signal);

    controller.abort(reason);
    await expect(first).rejects.toBe(reason);
    await expect(probe()).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(controller.signal);
  });

  test("keeps actionable binary and libx264 failures", async () => {
    const missing = createFfmpegAvailabilityProbe({
      resolveBinary: () => "/missing/ffmpeg",
      runExec: async () =>
        execResult({
          status: null,
          error: new Error("spawn /missing/ffmpeg ENOENT"),
        }),
    });
    await expect(missing()).rejects.toThrow(
      'ffmpeg not found or unusable (tried "/missing/ffmpeg"): spawn /missing/ffmpeg ENOENT',
    );

    const missingX264 = createFfmpegAvailabilityProbe({
      resolveBinary: () => "ffmpeg-without-x264",
      runExec: async () => execResult({ stdout: " V..... h264_videotoolbox" }),
    });
    await expect(missingX264()).rejects.toThrow(
      'ffmpeg at "ffmpeg-without-x264" does not include the libx264 encoder',
    );
  });
});

describe("H264Encoder validation", () => {
  const valid: H264EncoderOpts = {
    width: 576,
    height: 1280,
    fps: 60,
    bitRate: 8_000_000,
    keyFrameInterval: 10,
    onFrame: () => {},
    onExit: () => {},
  };

  test("rejects invalid dimensions before starting ffmpeg", () => {
    expect(() => new H264Encoder({ ...valid, width: 1 })).toThrow(
      "at least 2 pixels",
    );
    expect(() => new H264Encoder({ ...valid, height: 1.5 })).toThrow(
      "safe integer",
    );
    expect(() => new H264Encoder({ ...valid, width: 16_385 })).toThrow(
      "at most 16384",
    );
  });

  test("rejects invalid frame and rate settings before starting ffmpeg", () => {
    expect(() => new H264Encoder({ ...valid, fps: 0 })).toThrow(
      "fps must be greater than 0",
    );
    expect(() => new H264Encoder({ ...valid, bitRate: 0 })).toThrow(
      "bitRate must be greater than 0",
    );
    expect(() => new H264Encoder({ ...valid, keyFrameInterval: -1 })).toThrow(
      "non-negative",
    );
  });

  test("reports transposed output dimensions for quarter-turn encoding", async () => {
    const encoder = new H264Encoder({
      ...valid,
      width: 576,
      height: 1280,
      quarterTurn: 1,
    });

    expect({
      width: encoder.encodedWidth,
      height: encoder.encodedHeight,
    }).toEqual({ width: 1280, height: 576 });

    await encoder.close();
  });

  test("maps Android quarter turns to ffmpeg rotation filters", () => {
    const crop = "crop=trunc(iw/2)*2:trunc(ih/2)*2";
    expect(videoFilter(0)).toBe(crop);
    expect(videoFilter(1)).toBe(`${crop},transpose=cclock`);
    expect(videoFilter(2)).toBe(`${crop},hflip,vflip`);
    expect(videoFilter(3)).toBe(`${crop},transpose=clock`);
  });

  test("selects fixed rawvideo or framed PNG input without changing output timing", () => {
    expect(ffmpegInputArgs("rgb24", 360, 640, 30)).toEqual([
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-video_size",
      "360x640",
      "-framerate",
      "30",
      "-i",
      "pipe:0",
    ]);
    expect(ffmpegInputArgs("png", 360, 640, 30)).toEqual([
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-max_probe_packets",
      "1",
      "-f",
      "image2pipe",
      "-framerate",
      "30",
      "-c:v",
      "png",
      "-i",
      "pipe:0",
    ]);
  });

  test("validates PNG frame boundaries before writing to ffmpeg", async () => {
    const encoder = new H264Encoder({
      ...valid,
      inputFormat: "png",
    });
    expect(() => encoder.write(Buffer.from("not a png"), 1n)).toThrow(
      "complete PNG Buffer",
    );
    await encoder.close();
  });

  realFfmpegTest("signals readiness after RGB frames backpressure stdin", async () => {
    let resolveDrain!: () => void;
    let rejectDrain!: (error: Error) => void;
    const drained = new Promise<void>((resolve, reject) => {
      resolveDrain = resolve;
      rejectDrain = reject;
    });
    const timeout = setTimeout(() => rejectDrain(new Error("ffmpeg did not drain")), 2_000);
    const encoder = new H264Encoder({
      ...valid,
      width: 512,
      height: 512,
      onWritable: resolveDrain,
      onExit: (reason) => rejectDrain(new Error(reason)),
    });
    const pixels = Buffer.alloc(512 * 512 * 3);
    try {
      expect(encoder.writable).toBe(true);
      // Node and Bun have different pipe buffering capacities. Fill the pipe
      // without yielding, then verify the readiness contract at its actual limit.
      let pts = 1n;
      while (encoder.writable && pts <= 64n) {
        expect(encoder.write(pixels, pts++)).toBe(true);
      }
      expect(encoder.writable).toBe(false);
      expect(encoder.write(pixels, pts)).toBe(false);
      await drained;
      expect(encoder.writable).toBe(true);
      expect(encoder.write(pixels, pts)).toBe(true);
    } finally {
      clearTimeout(timeout);
      await encoder.close();
    }
    expect(encoder.writable).toBe(false);
  });

  realFfmpegTest(
    "accepts concatenated PNG images through image2pipe",
    async () => {
      const generated = spawnSync(
        resolveFfmpeg(),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=128x128",
          "-frames:v",
          "1",
          "-c:v",
          "png",
          "-f",
          "image2pipe",
          "pipe:1",
        ],
        { encoding: null },
      );
      expect(generated.status).toBe(0);
      const png = Buffer.from(generated.stdout);
      const frames: VideoFrame[] = [];
      let resolveKeyFrame!: () => void;
      let rejectKeyFrame!: (error: Error) => void;
      const keyFrame = new Promise<void>((resolve, reject) => {
        resolveKeyFrame = resolve;
        rejectKeyFrame = reject;
      });
      const encoder = new H264Encoder({
        ...valid,
        width: 128,
        height: 128,
        inputFormat: "png",
        onFrame(frame) {
          frames.push(frame);
          if (frame.isKey) resolveKeyFrame();
        },
        onExit(reason) {
          rejectKeyFrame(new Error(reason));
        },
      });

      // Keep enough framed input in the pipe for libavformat's initial stream
      // probe; real emulator PNGs are substantially larger than this fixture.
      for (let index = 0; index < 20; index++) {
        expect(encoder.write(png, BigInt(index + 1))).toBe(true);
      }
      await Promise.race([
        keyFrame,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for ffmpeg")),
            2_000,
          ),
        ),
      ]);
      await encoder.close();
      expect(frames.some((frame) => frame.isConfig)).toBe(true);
      expect(frames.some((frame) => frame.isKey)).toBe(true);
    },
  );

  realFfmpegTest(
    "applies Android quarter-turn direction to encoded pixels",
    async () => {
      // Keep both encoded dimensions at least one H.264 macroblock so this
      // real-ffmpeg test behaves consistently across libx264 builds.
      const width = 16;
      const height = 32;
      const rgb = Buffer.alloc(width * height * 3);
      const colors = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 255],
      ];
      for (let y = 0; y < height; y++) {
        const color = colors[Math.floor(y / (height / colors.length))]!;
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 3;
          rgb[offset] = color[0]!;
          rgb[offset + 1] = color[1]!;
          rgb[offset + 2] = color[2]!;
        }
      }

      let config: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let keyFrame: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let resolveKeyFrame!: () => void;
      let rejectKeyFrame!: (reason?: unknown) => void;
      const keyFrameReady = new Promise<void>((resolve, reject) => {
        resolveKeyFrame = resolve;
        rejectKeyFrame = reject;
      });
      const encoder = new H264Encoder({
        ...valid,
        width,
        height,
        quarterTurn: 1,
        onFrame(frame) {
          if (frame.isConfig) config = frame.data;
          else if (frame.isKey && keyFrame.length === 0) {
            keyFrame = frame.data;
            resolveKeyFrame();
          }
        },
        onExit(reason) {
          rejectKeyFrame(new Error(reason));
        },
      });
      encoder.write(rgb, 1n);
      encoder.write(rgb, 2n);
      await Promise.race([
        keyFrameReady,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for ffmpeg")),
            2_000,
          ),
        ),
      ]);
      await encoder.close();

      const decoded = spawnSync(
        resolveFfmpeg(),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "h264",
          "-i",
          "pipe:0",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { input: Buffer.concat([config, keyFrame]) },
      );
      expect(decoded.status).toBe(0);

      const topRow = colors.map((_, index) => {
        const x = index * (height / colors.length);
        const offset = x * 3;
        return [...decoded.stdout.subarray(offset, offset + 3)];
      });
      expect(topRow).toEqual([
        expect.arrayContaining([expect.any(Number), 0, 0]),
        expect.arrayContaining([0, expect.any(Number), 0]),
        expect.arrayContaining([0, 0, expect.any(Number)]),
        expect.arrayContaining([
          expect.any(Number),
          expect.any(Number),
          expect.any(Number),
        ]),
      ]);
      expect(topRow[0]![0]).toBeGreaterThan(200);
      expect(topRow[1]![1]).toBeGreaterThan(200);
      expect(topRow[2]![2]).toBeGreaterThan(200);
      expect(Math.min(...topRow[3]!)).toBeGreaterThan(200);
    },
  );
});

describe("ffmpeg diagnostics", () => {
  test("retains a bounded stderr tail for exit failures", () => {
    const stderr = new FfmpegStderrTail();
    stderr.append(Buffer.from(`discarded:${"x".repeat(20_000)}`));
    stderr.append(Buffer.from(":actionable failure\n"));

    expect(Buffer.byteLength(stderr.text())).toBeLessThanOrEqual(16 * 1024);
    expect(stderr.text()).not.toContain("discarded:");
    expect(stderr.text()).toEndWith(":actionable failure");
  });
});

realHardwareTest("streams real hardware H.264 after only one idle duplicate, before stdin closes", async () => {
  const frames: VideoFrame[] = [];
  let resolveFrame!: () => void;
  let rejectFrame!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveFrame = resolve;
    rejectFrame = reject;
  });
  const encoder = new H264Encoder({
    width: 256, height: 256, fps: 30, bitRate: 1_000_000, keyFrameInterval: 1,
    encoderName: hostHardwareEncoder as FfmpegEncoderName,
    onFrame(frame) { frames.push(frame); if (frame.isKey) resolveFrame(); },
    onExit(reason) { rejectFrame(new Error(reason)); },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const image = Buffer.alloc(256 * 256 * 3, 96);
    // Honour pipe backpressure, as the actual gRPC capture session does.
    for (let index = 1; index <= 2; index++) {
      const deadline = Date.now() + 1_000;
      while (!encoder.write(image, BigInt(index))) {
        if (Date.now() >= deadline) throw new Error("hardware input never drained");
        await Bun.sleep(10);
      }
      await Bun.sleep(100);
    }
    await Promise.race([ready, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("hardware did not stream before EOF")), 2_000);
    })]);
    expect(frames.some((frame) => frame.isConfig)).toBe(true);
    expect(frames.some((frame) => frame.isKey && frame.pts === 1n)).toBe(true);
  } finally {
    clearTimeout(timeout);
    await encoder.close();
  }
});
