import { spawn } from "node:child_process";
import {
  EmulatorGrpcClient,
  findEmulatorGrpcEndpoint,
  IMG_FORMAT_PNG,
  IMG_FORMAT_RGB888,
  type EmuImage,
} from "./emulator-grpc.ts";
import { H264Encoder, assertFfmpegAvailable } from "./h264-encoder.ts";
import { truncateTextUtf8, type Gesture } from "./input.ts";
import type { StartOpts, VideoFrame } from "./scrcpy.ts";
import type { EmuSession } from "./session.ts";

/**
 * Emulator streaming session over the emulator's built-in gRPC endpoint:
 * raw frames are pulled host-side (streamScreenshot) and encoded to H.264 by
 * a host ffmpeg, and input goes through host-side injection (sendTouch ~0.3ms
 * round-trip vs ~5ms for scrcpy's control socket). The guest runs nothing —
 * unlike scrcpy there is no in-guest capture or MediaCodec encode competing
 * with the app under test for emulated CPU.
 */

// Video pacing. The emulator pushes frames only when the display changes (at
// up to ~60fps); we coalesce to maxFps for scrcpy parity. Because x264 only
// surfaces an access unit when the next one starts (see h264-encoder.ts), a
// fresh frame is chased by one duplicate write after FLUSH_MS to bound
// latency, and IDLE_REPEAT_MS keeps a trickle of tiny skip-frames flowing on
// a static screen so the middleware's stall watchdog stays quiet.
const FLUSH_MS = 40;
const IDLE_REPEAT_MS = 500;
const IDLE_TICK_MS = 250;
const RESTART_MIN_INTERVAL_MS = 1_000;
const FIRST_FRAME_TIMEOUT_MS = 10_000;
const MAX_QUEUED_FRAMES = 256;
const MAX_TEXT_BYTES = 300;
const TOUCH_PRESSURE = 1;

// Android keycodes (input.ts KEY / client "key" gestures) → W3C KeyboardEvent
// key values the emulator's keyboard translator understands.
const ANDROID_KEYCODE_TO_W3C: Record<number, string> = {
  3: "GoHome",
  4: "GoBack",
  19: "ArrowUp",
  20: "ArrowDown",
  21: "ArrowLeft",
  22: "ArrowRight",
  24: "AudioVolumeUp",
  25: "AudioVolumeDown",
  26: "Power",
  61: "Tab",
  66: "Enter",
  67: "Backspace",
  92: "PageUp",
  93: "PageDown",
  111: "Escape",
  112: "Delete",
  122: "Home",
  123: "End",
  164: "AudioVolumeMute",
  187: "AppSwitch",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function adbKeyEvent(serial: string, keycode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("adb", ["-s", serial, "shell", "input", "keyevent", String(keycode)]);
    proc.once("error", reject);
    proc.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`adb input keyevent ${keycode} exited with ${code}`)),
    );
  });
}

export async function startGrpcSession(opts: StartOpts): Promise<EmuSession> {
  const { serial } = opts;
  const maxFps = opts.maxFps ?? 30;
  const bitRate = opts.bitRate ?? 8_000_000;
  const maxSize = opts.maxSize ?? 1280;
  const keyFrameInterval = opts.keyFrameInterval ?? 1;
  const paceMs = Math.max(1, Math.round(1000 / maxFps));

  const endpoint = findEmulatorGrpcEndpoint(serial);
  if (!endpoint) {
    throw new Error(
      `no gRPC endpoint found for ${serial} (no emulator discovery file matches — the emulator may be too old or running with gRPC disabled)`,
    );
  }
  assertFfmpegAvailable();

  const client = new EmulatorGrpcClient(endpoint);
  let closed = false;
  let fatalReason: string | null = null;
  let fatalCb: ((reason: string) => void) | null = null;

  // --- frame plumbing: encoder output → readFrame() consumer -------------
  const frameQueue: VideoFrame[] = [];
  const waiters: ((frame: VideoFrame | null) => void)[] = [];
  const pushFrame = (frame: VideoFrame) => {
    if (closed || fatalReason) return;
    const waiter = waiters.shift();
    if (waiter) return waiter(frame);
    frameQueue.push(frame);
    // Emergency valve for a stalled consumer; clients resync on next keyframe.
    if (frameQueue.length > MAX_QUEUED_FRAMES) frameQueue.splice(0, frameQueue.length - MAX_QUEUED_FRAMES);
  };
  const wakeAll = () => {
    while (waiters.length) waiters.shift()!(null);
  };
  const readFrame = (): Promise<VideoFrame | null> => {
    const frame = frameQueue.shift();
    if (frame) return Promise.resolve(frame);
    if (closed || fatalReason) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  };

  const emitFatal = (reason: string) => {
    if (closed || fatalReason) return;
    fatalReason = reason;
    wakeAll();
    fatalCb?.(reason);
  };
  client.onSessionError((err) => emitFatal(`emulator grpc connection error: ${err.message}`));

  // --- video: streamScreenshot → paced ffmpeg writes ----------------------
  let encoder: H264Encoder | null = null;
  let latest: EmuImage | null = null;
  let lastWriteAt = 0;
  let lastEncoderStartAt = 0;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const nowUs = () => BigInt(Math.round(performance.now() * 1000));

  const writeFrame = (repeat: boolean) => {
    if (closed || !encoder || !latest) return;
    encoder.write(latest.image, nowUs());
    lastWriteAt = Date.now();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!repeat) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        writeFrame(true);
      }, FLUSH_MS);
    }
  };

  const scheduleWrite = () => {
    if (writeTimer) return;
    const wait = lastWriteAt + paceMs - Date.now();
    if (wait <= 0) return writeFrame(false);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      writeFrame(false);
    }, wait);
  };

  const startEncoder = () => {
    if (closed || !latest) return;
    encoder?.close();
    lastEncoderStartAt = Date.now();
    encoder = new H264Encoder({
      width: latest.width,
      height: latest.height,
      fps: maxFps,
      bitRate,
      keyFrameInterval,
      onFrame: pushFrame,
      onExit: emitFatal,
    });
    writeFrame(false); // seeds SPS/PPS + IDR; the flush chase surfaces it
  };

  let resolveFirstFrame: ((image: EmuImage) => void) | null = null;
  const onImage = (image: EmuImage) => {
    if (closed) return;
    latest = image;
    if (resolveFirstFrame) {
      const resolve = resolveFirstFrame;
      resolveFirstFrame = null;
      resolve(image);
      return;
    }
    if (encoder && (image.width !== encoder.width || image.height !== encoder.height)) {
      startEncoder(); // rotation or display resize: dims changed mid-stream
      return;
    }
    scheduleWrite();
  };

  const abort = new AbortController();
  const idleTicker = setInterval(() => {
    if (closed || !encoder) return;
    if (Date.now() - lastWriteAt >= IDLE_REPEAT_MS) writeFrame(true);
  }, IDLE_TICK_MS);

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(idleTicker);
    if (writeTimer) clearTimeout(writeTimer);
    if (flushTimer) clearTimeout(flushTimer);
    abort.abort();
    encoder?.close();
    client.close();
    wakeAll();
  };

  try {
    // Touch coordinates are native display pixels while the stream is scaled,
    // so learn the native size up front (rotation-normalized to portrait).
    const probe = await client.getScreenshot({ format: IMG_FORMAT_PNG });
    const probeLandscape = probe.rotation === 1 || probe.rotation === 3;
    const portraitNative = {
      width: probeLandscape ? probe.height : probe.width,
      height: probeLandscape ? probe.width : probe.height,
    };

    const firstFrame = new Promise<EmuImage>((resolve, reject) => {
      resolveFirstFrame = resolve;
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for the first emulator frame")),
        FIRST_FRAME_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    void client
      .streamScreenshot(
        { format: IMG_FORMAT_RGB888, width: maxSize, height: maxSize },
        onImage,
        abort.signal,
      )
      .then(
        () => emitFatal("emulator screenshot stream ended"),
        (err) => emitFatal(`emulator screenshot stream failed: ${err instanceof Error ? err.message : err}`),
      );
    const first = await firstFrame;
    startEncoder();

    const currentNative = () => {
      const rotation = latest?.rotation ?? probe.rotation;
      return rotation === 1 || rotation === 3
        ? { width: portraitNative.height, height: portraitNative.width }
        : portraitNative;
    };
    const touch = (unitX: number, unitY: number, pressure: number, identifier = 0) => {
      const native = currentNative();
      return client.sendTouch([
        {
          x: Math.min(native.width - 1, Math.round(unitX * native.width)),
          y: Math.min(native.height - 1, Math.round(unitY * native.height)),
          identifier,
          pressure,
        },
      ]);
    };

    const sendGesture = async (gesture: Gesture): Promise<void> => {
      if (closed) throw new Error("session closed");
      switch (gesture.type) {
        case "tap":
          await touch(gesture.x, gesture.y, TOUCH_PRESSURE);
          await sleep(20);
          await touch(gesture.x, gesture.y, 0);
          return;
        case "swipe": {
          const dur = Math.max(80, gesture.durationMs ?? 250);
          const steps = Math.max(8, Math.round(dur / 16));
          await touch(gesture.x1, gesture.y1, TOUCH_PRESSURE);
          for (let i = 1; i < steps; i++) {
            const t = i / steps;
            await sleep(dur / steps);
            await touch(
              gesture.x1 + (gesture.x2 - gesture.x1) * t,
              gesture.y1 + (gesture.y2 - gesture.y1) * t,
              TOUCH_PRESSURE,
            );
          }
          await sleep(dur / steps);
          await touch(gesture.x2, gesture.y2, 0);
          return;
        }
        case "touch":
          await touch(
            gesture.x,
            gesture.y,
            gesture.action === "up" ? 0 : TOUCH_PRESSURE,
            gesture.pointerId ?? 0,
          );
          return;
        case "key": {
          const key = ANDROID_KEYCODE_TO_W3C[gesture.keycode];
          if (key) return void (await client.sendKey({ key }));
          // Unmapped Android keycodes take the slow adb path (~200ms); the
          // common ones all resolve to W3C key values above.
          await adbKeyEvent(serial, gesture.keycode);
          return;
        }
        case "text":
          await client.sendKey({ text: truncateTextUtf8(gesture.text, MAX_TEXT_BYTES) });
          return;
        case "back":
          await client.sendKey({ key: "GoBack" });
          return;
        case "home":
          await client.sendKey({ key: "GoHome" });
          return;
        case "recents":
          await client.sendKey({ key: "AppSwitch" });
          return;
        case "power":
          await client.sendKey({ key: "Power" });
          return;
      }
    };

    return {
      transport: "grpc",
      serial,
      meta: {
        deviceName: endpoint.avdName ?? serial,
        codecId: "h264",
        width: first.width,
        height: first.height,
      },
      readFrame,
      sendGesture,
      // ffmpeg cannot force an IDR mid-stream over a pipe, so a keyframe
      // request restarts the encoder — it opens on SPS/PPS + IDR. Rate-limited
      // on top of the middleware's own reset cooldown.
      resetVideo: () => {
        if (closed || Date.now() - lastEncoderStartAt < RESTART_MIN_INTERVAL_MS) return;
        startEncoder();
      },
      onFatal: (cb) => {
        fatalCb = cb;
        if (fatalReason) cb(fatalReason);
      },
      close,
    };
  } catch (err) {
    close();
    throw err;
  }
}
