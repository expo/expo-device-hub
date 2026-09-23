/**
 * Typed loader + wrapper for serve-sim-native.node — the in-process N-API addon
 * that replaces the spawned serve-sim-bin helper. HID is the first surface;
 * frame capture + encoders land here next.
 *
 * The .node is resolved from disk (dist/native/) relative to either this module
 * or the bun-compiled executable, so it loads under `npx serve-sim`, the
 * compiled binary, and the mounted middleware alike.
 */
import { createRequire } from "module";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import {
  DEFAULT_STREAM_ENCODER_SETTINGS,
  type StreamEncoderSettings,
} from "./stream-settings";
import { readSenderStats, type SenderStats } from "./webrtc-sender-stats";
import type { HingePhysicalOrientation } from "./hinge-control";

const require = createRequire(import.meta.url);

// The addon exposes two NodeClasses (SimHID, SimCapture) plus two async
// functions. NodeClass instances clean up their native resources when the JS
// handle is garbage-collected (Swift `deinit`), so there are no explicit
// destroy/free calls here.
interface SimHIDHandle {
  setScreen(screenId: number): Promise<void>;
  supportsHingeAngle(): Promise<boolean>;
  hingeState(): Promise<NativeHingeState>;
  setHingeAngle(angle: number): Promise<boolean>;
  setHingePose(pose: string): Promise<boolean>;
  setTableMode(enabled: boolean): Promise<boolean>;
  touch(type: TouchType, x: number, y: number, w: number, hh: number, edge: number): Promise<void>;
  multiTouch(type: TouchType, x1: number, y1: number, x2: number, y2: number, w: number, hh: number): Promise<void>;
  button(button: string): Promise<void>;
  buttonHid(page: number, usage: number, phase: ButtonPhase): Promise<void>;
  key(type: KeyType, usage: number): Promise<void>;
  scroll(dx: number, dy: number, anchorX: number, anchorY: number, w: number, hh: number): Promise<void>;
  digitalCrown(delta: number): Promise<void>;
  orientation(orientation: number): Promise<boolean>;
  memoryWarning(): Promise<void>;
  softwareKeyboard(): Promise<void>;
  caDebug(name: string, enabled: boolean): Promise<boolean>;
}

interface SimCaptureHandle {
  start(): Promise<void>;
  updateStreamSettings(
    mjpegFps: number,
    mjpegQuality: number,
    maxDimension: number,
    h264Fps: number,
    h264Bitrate: number,
  ): Promise<void>;
  handleWebRTCOffer(offerJson: string): Promise<string>;
  closeWebRTCSession(sessionId: string): Promise<void>;
  webRTCSenderStats(sessionId: string): Promise<string>;
  screenSize(): Promise<NativeScreenInfo>;
  subscribeScreenChanges(onChange: () => Promise<void>): Promise<NativeUnsubscribe>;
  stop(): Promise<void>;
  subscribe(codec: number, onFrame: RawFrameCallback): Promise<NativeUnsubscribe>;
}

interface NativeAddon {
  SimHID: new (udid: string) => SimHIDHandle;
  SimCapture: new (
    udid: string,
    mjpegFps: number,
    mjpegQuality: number,
    maxDimension: number,
    h264Fps: number,
    h264Bitrate: number,
    screenId?: number,
  ) => SimCaptureHandle;
  axDescribe(udid: string): Promise<string>;
  axFrontmost(udid: string): Promise<string>;
  setHardwareKeyboard(udid: string, enabled: boolean): Promise<boolean>;
}

// (codec, data, width, height, flags) — codec 0=MJPEG 1=AVCC; flags bit0=desc bit1=keyframe.
type RawFrameCallback = (
  data: Uint8Array,
  width: number,
  height: number,
  flags: number,
) => Promise<void>;

const CODEC_MJPEG = 0;
const CODEC_AVCC = 1;
const FLAG_DESCRIPTION = 1 << 0;
const FLAG_KEYFRAME = 1 << 1;

export type MjpegFrame = {
  data: Uint8Array;
  width: number;
  height: number;
};

export type AvccFrame = {
  data: Uint8Array;
  width: number;
  height: number;
  isDescription: boolean;
  isKeyframe: boolean;
};

export type NativeCaptureOptions = StreamEncoderSettings;

export type NativeHingeState = {
  hingeAngle?: number;
  tableMode?: boolean;
  physicalOrientation?: HingePhysicalOrientation;
};

export type NativeScreenInfo = {
  width: number;
  height: number;
  /** Present when CoreSimulator exposes its active screen metadata. */
  orientation?: "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right";
  screenId?: number;
  chromeIdentifier?: string;
};

export type NativeUnsubscribe = () => Promise<void>;

export type TouchType = "begin" | "move" | "end";
export type KeyType = "down" | "up";
export type ButtonPhase = "down" | "up" | "press";

/** UIDeviceOrientation values the simulator's GraphicsServices accepts. */
export const Orientation = {
  portrait: 1,
  portraitUpsideDown: 2,
  landscapeRight: 3,
  landscapeLeft: 4,
} as const;

function resolveAddon(): string {
  const candidates = [
    // Beside the bun-compiled executable (dist/serve-sim → dist/native/…).
    // Arm64 macOS addon; loaded by path so it works under npx, the
    // compiled binary, and the dev server alike.
    join(dirname(process.execPath), "native", "serve-sim-native.node"),
    // Beside the bundled JS (dist/serve-sim.js or dist/middleware.js).
    join(dirname(fileURLToPath(import.meta.url)), "native", "serve-sim-native.node"),
    // Dev: running from source (src/native.ts → ../dist/native/…).
    join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "native", "serve-sim-native.node"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `serve-sim-native.node not found. Looked in:\n  ${candidates.join("\n  ")}\n` +
      "Run `bun run build.ts` to build the native addon.",
  );
}

let addon: NativeAddon | undefined;
function load(): NativeAddon {
  if (!addon) addon = require(resolveAddon()) as NativeAddon;
  return addon;
}

/**
 * In-process HID injector for one simulator. Mirrors the WebSocket HID protocol
 * the spawned helper used to handle, but as direct native calls.
 */
export class NativeHid {
  private readonly handle: SimHIDHandle;
  private inputUnavailable = false;

  constructor(udid: string) {
    this.handle = new (load().SimHID)(udid);
  }

  // The N-API bindings throw synchronously when a JS value can't be coerced to
  // the native parameter type (e.g. a touch with a non-string `type` →
  // "Could not convert parameter 0 to type String"). HID now runs in-process,
  // so an unhandled throw here crashes the whole server — and if it lands
  // mid-gesture, the guest is left with a stuck finger that wedges input until
  // the sim reboots. The spawned helper used to absorb this in its own process;
  // `guard` restores that isolation by swallowing malformed-input errors.
  private async guard<T>(op: string, fn: () => PromiseLike<T>, fallback: T): Promise<T> {
    if (this.inputUnavailable) return fallback;
    try {
      return await fn();
    } catch (err) {
      console.error(`[hid] ${op} ignored bad input:`, err instanceof Error ? err.message : err);
      return fallback;
    }
  }

  touch(type: TouchType, x: number, y: number, w: number, h: number, edge = 0): Promise<void> {
    return this.guard("touch", () => this.handle.touch(type, x, y, w, h, edge), undefined);
  }

  async setScreen(screenId: number): Promise<void> {
    if (this.inputUnavailable) return;
    try {
      await this.handle.setScreen(screenId);
    } catch (err) {
      // Native setup is cached for this handle; a failed setup cannot recover
      // until a new session. Keep capture running without calling partial HID state.
      this.inputUnavailable = true;
      console.error("[hid] Input setup failed; streaming will continue without input:", err instanceof Error ? err.message : err);
    }
  }

  setHingeAngle(angle: number): Promise<boolean> {
    return this.guard("setHingeAngle", () => this.handle.setHingeAngle(angle), false);
  }

  setHingePose(pose: string): Promise<boolean> {
    return this.guard("setHingePose", () => this.handle.setHingePose(pose), false);
  }

  setTableMode(enabled: boolean): Promise<boolean> {
    return this.guard("setTableMode", () => this.handle.setTableMode(enabled), false);
  }

  supportsHingeAngle(): Promise<boolean> {
    return this.guard("supportsHingeAngle", () => this.handle.supportsHingeAngle(), false);
  }

  hingeState(): Promise<NativeHingeState> {
    return this.guard("hingeState", () => this.handle.hingeState(), {});
  }

  multiTouch(type: TouchType, x1: number, y1: number, x2: number, y2: number, w: number, h: number): Promise<void> {
    return this.guard("multiTouch", () => this.handle.multiTouch(type, x1, y1, x2, y2, w, h), undefined);
  }

  button(button: string): Promise<void> {
    return this.guard("button", () => this.handle.button(button), undefined);
  }

  buttonHid(page: number, usage: number, phase: ButtonPhase = "press"): Promise<void> {
    return this.guard("buttonHid", () => this.handle.buttonHid(page, usage, phase), undefined);
  }

  key(type: KeyType, usage: number): Promise<void> {
    return this.guard("key", () => this.handle.key(type, usage), undefined);
  }

  /** anchorX/anchorY default to screen center when omitted. */
  scroll(dx: number, dy: number, w: number, h: number, anchorX?: number, anchorY?: number): Promise<void> {
    return this.guard("scroll", () => this.handle.scroll(dx, dy, anchorX ?? NaN, anchorY ?? NaN, w, h), undefined);
  }

  digitalCrown(delta: number): Promise<void> {
    return this.guard("digitalCrown", () => this.handle.digitalCrown(delta), undefined);
  }

  orientation(orientation: number): Promise<boolean> {
    return this.guard("orientation", () => this.handle.orientation(orientation), false);
  }

  memoryWarning(): Promise<void> {
    return this.guard("memoryWarning", () => this.handle.memoryWarning(), undefined);
  }

  softwareKeyboard(): Promise<void> {
    return this.guard("softwareKeyboard", () => this.handle.softwareKeyboard(), undefined);
  }

  caDebug(name: string, enabled: boolean): Promise<boolean> {
    return this.guard("caDebug", () => this.handle.caDebug(name, enabled), false);
  }
}

/**
 * In-process frame capture + encode for one simulator. Replaces the spawned
 * helper's capture pipeline. MJPEG and H.264/AVCC frames are produced while
 * callers hold codec-specific subscriptions; encoded frames arrive on the JS
 * thread after being marshalled from the native encode thread.
 */
export class NativeCapture {
  private readonly handle: SimCaptureHandle;

  /** A fixed screen ID captures that panel independently of active-display/input routing. */
  constructor(udid: string, options: NativeCaptureOptions = DEFAULT_STREAM_ENCODER_SETTINGS, screenId?: number) {
    if (screenId !== undefined && (!Number.isInteger(screenId) || screenId < 0 || screenId > 0xffff_ffff)) {
      throw new RangeError("Screen ID must be an unsigned 32-bit integer.");
    }
    this.handle = new (load().SimCapture)(
      udid,
      options.mjpegFps,
      options.mjpegQuality,
      options.maxDimension,
      options.h264Fps,
      options.h264Bitrate,
      screenId ?? 0,
    );
  }

  /** Begin capturing. Throws if the device isn't booted. */
  start(): Promise<void> {
    return this.handle.start();
  }

  updateStreamSettings(options: NativeCaptureOptions): Promise<void> {
    return this.handle.updateStreamSettings(
      options.mjpegFps,
      options.mjpegQuality,
      options.maxDimension,
      options.h264Fps,
      options.h264Bitrate,
    );
  }

  subscribeMjpeg(onFrame: (frame: MjpegFrame) => Promise<void>): Promise<NativeUnsubscribe> {
    return this.handle.subscribe(CODEC_MJPEG, (data, width, height, _flags) => {
      return onFrame({ data, width, height });
    });
  }

  subscribeAvcc(onFrame: (frame: AvccFrame) => Promise<void>): Promise<NativeUnsubscribe> {
    return this.handle.subscribe(CODEC_AVCC, (data, width, height, flags) => {
      return onFrame({
        data,
        width,
        height,
        isDescription: (flags & FLAG_DESCRIPTION) !== 0,
        isKeyframe: (flags & FLAG_KEYFRAME) !== 0,
      });
    });
  }

  async handleWebRTCOffer(offer: unknown): Promise<unknown> {
    return JSON.parse(await this.handle.handleWebRTCOffer(JSON.stringify(offer)));
  }

  closeWebRTCSession(sessionId: string): Promise<void> {
    return this.handle.closeWebRTCSession(sessionId);
  }

  /**
   * Sender-side statistics for live WebRTC sessions. Pass a session id to gather that viewer only;
   * omit it for every session (`--debug-stream`). `qualityLimitationReason` lives here only: a
   * receive-only browser cannot tell a CPU-bound encoder from a starved network.
   */
  async webRTCSenderStats(sessionId?: string): Promise<SenderStats> {
    return readSenderStats(JSON.parse(await this.handle.webRTCSenderStats(sessionId ?? "")));
  }

  screenSize(): Promise<NativeScreenInfo> {
    return this.handle.screenSize();
  }

  subscribeScreenChanges(onChange: () => Promise<void>): Promise<NativeUnsubscribe> {
    return this.handle.subscribeScreenChanges(onChange);
  }

  /** Halt frame production. Full teardown happens when this object is GC'd. */
  stop(): Promise<void> {
    return this.handle.stop();
  }
}

/**
 * Async accessibility-tree dump for `udid`, as an axe-shaped JSON string (the
 * src/ax.ts normalizer consumes it unchanged). Runs native AX work off the JS
 * event loop. Rejects if the sim's AX service isn't reachable yet.
 */
export function axDescribeAsync(udid: string): Promise<string> {
  return load().axDescribe(udid);
}

/** Async frontmost-app probe — JSON string `{ bundleId, pid }` for the visible app. */
export function axFrontmostAsync(udid: string): Promise<string> {
  return load().axFrontmost(udid);
}

/**
 * Connect/disconnect the device's hardware keyboard (⌘⇧K). Disconnecting makes
 * the guest show its on-screen keyboard. Per-device; resolves true when the
 * CoreSimulator call succeeds (not a read-back of the resulting state).
 */
export function setHardwareKeyboard(udid: string, enabled: boolean): Promise<boolean> {
  return load().setHardwareKeyboard(udid, enabled);
}
