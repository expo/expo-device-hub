import { spawnSync } from "node:child_process";
import {
  EmulatorGrpcClient,
  ensureEmulatorGrpcEndpoint,
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

// Android keycodes (input.ts KEY / client "key" gestures) → Linux evdev
// codes for non-printable physical keys. Printable keys use the emulator's
// W3C character path below so keyboard layout/modifier handling stays native.
const ANDROID_KEYCODE_TO_EVDEV: Record<number, number> = {
  19: 103, // KEY_UP
  20: 108, // KEY_DOWN
  21: 105, // KEY_LEFT
  22: 106, // KEY_RIGHT
  24: 115, // KEY_VOLUMEUP
  25: 114, // KEY_VOLUMEDOWN
  61: 15, // KEY_TAB
  66: 28, // KEY_ENTER
  67: 14, // KEY_BACKSPACE
  92: 104, // KEY_PAGEUP
  93: 109, // KEY_PAGEDOWN
  111: 1, // KEY_ESC
  112: 111, // KEY_DELETE
  122: 102, // KEY_HOME → Android MOVE_HOME in Generic.kl
  123: 107, // KEY_END → Android MOVE_END in Generic.kl
  164: 113, // KEY_MUTE
};

const ANDROID_PRINTABLE_KEYCODE_TO_W3C: Record<number, string> = {
  55: ",",
  56: ".",
  62: " ",
  68: "`",
  69: "-",
  70: "=",
  71: "[",
  72: "]",
  73: "\\",
  74: ";",
  75: "'",
  76: "/",
  77: "@",
  81: "+",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readNavigationMode(serial: string): 0 | 1 | 2 | null {
  const result = spawnSync(
    "adb",
    ["-s", serial, "shell", "settings", "get", "secure", "navigation_mode"],
    { encoding: "utf8", timeout: 5_000 },
  );
  const mode = Number(result.stdout.trim());
  return result.status === 0 && (mode === 0 || mode === 1 || mode === 2) ? mode : null;
}

function runPowerCommand(serial: string, action: "sleep" | "wakeup"): void {
  const result = spawnSync("adb", ["-s", serial, "shell", "cmd", "power", action], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `could not ${action} ${serial}: ${result.stderr.trim() || result.stdout.trim() || result.error?.message || `adb exited with ${result.status}`}`,
    );
  }
}

function isDeviceAwake(serial: string): boolean {
  const result = spawnSync("adb", ["-s", serial, "shell", "dumpsys", "power"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `could not read power state for ${serial}: ${result.stderr.trim() || result.error?.message || `adb exited with ${result.status}`}`,
    );
  }
  return /mWakefulness=Awake\b/.test(result.stdout);
}

function toggleDevicePower(serial: string): void {
  runPowerCommand(serial, isDeviceAwake(serial) ? "sleep" : "wakeup");
}

function androidKeycodeToW3c(keycode: number): string | null {
  const named = ANDROID_PRINTABLE_KEYCODE_TO_W3C[keycode];
  if (named) return named;
  // Android KEYCODE_0..9 and KEYCODE_A..Z are contiguous.
  if (keycode >= 7 && keycode <= 16) return String(keycode - 7);
  if (keycode >= 29 && keycode <= 54) return String.fromCharCode(97 + keycode - 29);
  return null;
}

function isUsableRgbFrame(image: EmuImage): boolean {
  return (
    image.format === IMG_FORMAT_RGB888 &&
    image.width > 0 &&
    image.height > 0 &&
    image.image.length === image.width * image.height * 3
  );
}

export async function startGrpcSession(opts: StartOpts): Promise<EmuSession> {
  const { serial } = opts;
  const maxFps = opts.maxFps ?? 30;
  const bitRate = opts.bitRate ?? 8_000_000;
  const maxSize = opts.maxSize ?? 1280;
  const keyFrameInterval = opts.keyFrameInterval ?? 1;
  const paceMs = Math.max(1, Math.round(1000 / maxFps));

  assertFfmpegAvailable();
  const endpoint = await ensureEmulatorGrpcEndpoint(serial);

  const client = new EmulatorGrpcClient(endpoint);
  const navigationMode = readNavigationMode(serial);
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
    const accepted = encoder.write(latest.image, nowUs());
    lastWriteAt = Date.now();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!repeat && accepted) {
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
    // The emulator explicitly emits empty frames while a display is inactive.
    // Feeding one (or a partial raw payload) into ffmpeg would permanently
    // desynchronize the rawvideo byte stream.
    if (closed || !isUsableRgbFrame(image)) return;
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
    if (!isDeviceAwake(serial)) {
      runPowerCommand(serial, "wakeup");
      await sleep(100);
    }
    let probe = await client.getScreenshot({ format: IMG_FORMAT_PNG });
    if (probe.width <= 0 || probe.height <= 0) {
      // A sleeping display produces explicit 0×0 images. Wake through the
      // power service (not `adb shell input`) so startup can learn dimensions
      // and expose a usable stream on keyboard-less AVDs.
      runPowerCommand(serial, "wakeup");
      for (let attempt = 0; attempt < 20 && (probe.width <= 0 || probe.height <= 0); attempt++) {
        await sleep(100);
        probe = await client.getScreenshot({ format: IMG_FORMAT_PNG });
      }
      if (probe.width <= 0 || probe.height <= 0) {
        throw new Error("emulator display stayed inactive after requesting wakeup");
      }
    }
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
    const swipeTouch = async (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      durationMs: number,
      holdMs = 0,
    ) => {
      const dur = Math.max(80, durationMs);
      const steps = Math.max(8, Math.round(dur / 16));
      await touch(x1, y1, TOUCH_PRESSURE);
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        await sleep(dur / steps);
        await touch(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, TOUCH_PRESSURE);
      }
      await sleep(dur / steps + holdMs);
      await touch(x2, y2, 0);
    };
    const tapTouch = async (x: number, y: number) => {
      await touch(x, y, TOUCH_PRESSURE);
      await sleep(20);
      await touch(x, y, 0);
    };

    // Navigate through the on-screen system UI so controls also work on AVDs
    // with hw.keyboard=false. Modes: 0 = 3-button, 1 = 2-button, 2 = gestural.
    const goBack = () =>
      navigationMode === 2
        ? swipeTouch(0.002, 0.5, 0.28, 0.5, 180)
        : navigationMode === 0 || navigationMode === 1
          ? tapTouch(0.17, 0.985)
          : client.sendKey({ key: "GoBack" });
    const goHome = () =>
      navigationMode === 2
        ? swipeTouch(0.5, 0.995, 0.5, 0.65, 250)
        : navigationMode === 0 || navigationMode === 1
          ? tapTouch(0.5, 0.985)
          : client.sendKey({ key: "GoHome" });
    const openRecents = () =>
      navigationMode === 0
        ? tapTouch(0.83, 0.985)
        : navigationMode === 1 || navigationMode === 2
          ? swipeTouch(0.5, 0.995, 0.5, 0.55, 280, 500)
          : client.sendKey({ key: "AppSwitch" });

    const sendGesture = async (gesture: Gesture): Promise<void> => {
      if (closed) throw new Error("session closed");
      switch (gesture.type) {
        case "tap":
          await touch(gesture.x, gesture.y, TOUCH_PRESSURE);
          await sleep(20);
          await touch(gesture.x, gesture.y, 0);
          return;
        case "swipe": {
          await swipeTouch(
            gesture.x1,
            gesture.y1,
            gesture.x2,
            gesture.y2,
            gesture.durationMs ?? 250,
          );
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
          if (gesture.keycode === 3) return goHome();
          if (gesture.keycode === 4) return goBack();
          if (gesture.keycode === 26) return void toggleDevicePower(serial);
          if (gesture.keycode === 187) return openRecents();
          const evdev = ANDROID_KEYCODE_TO_EVDEV[gesture.keycode];
          if (evdev) {
            await client.sendEvdevKeyPress(evdev);
            return;
          }
          const key = androidKeycodeToW3c(gesture.keycode);
          if (!key) {
            throw new Error(`Android keycode ${gesture.keycode} is unsupported by the gRPC backend`);
          }
          await client.sendKey({ key });
          return;
        }
        case "text":
          await client.sendKey({ text: truncateTextUtf8(gesture.text, MAX_TEXT_BYTES) });
          return;
        case "back":
          await goBack();
          return;
        case "home":
          await goHome();
          return;
        case "recents":
          await openRecents();
          return;
        case "power":
          toggleDevicePower(serial);
          return;
      }
    };

    return {
      transport: "grpc",
      serial,
      meta: {
        deviceName: endpoint.avdName ?? serial,
        codecId: "h264",
        width: first.width - (first.width % 2),
        height: first.height - (first.height % 2),
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
