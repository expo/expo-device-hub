import { startGrpcSession } from "./grpc-session.ts";
import { dispatch, resetVideoPacket, type Gesture, type Screen } from "./input.ts";
import { startScrcpy, type ScrcpyMeta, type StartOpts, type VideoFrame } from "./scrcpy.ts";

/**
 * Backend selection:
 * - "scrcpy" (default): in-guest capture + MediaCodec encode, streamed over
 *   adb. Works for emulators and physical devices.
 * - "grpc": host-side capture through the emulator's built-in gRPC endpoint
 *   plus host-side ffmpeg encode — zero guest overhead, so stream fps and
 *   input latency no longer depend on emulated CPU. Emulators only; physical
 *   devices always use scrcpy, and a grpc failure falls back to scrcpy.
 *
 * Selected per session via AppOptions.backend, defaulting to the
 * SERVE_EMU_BACKEND environment variable.
 */
export type EmuBackend = "scrcpy" | "grpc";

export type SessionOpts = StartOpts & { backend?: string };

/**
 * Transport-agnostic device streaming session. Both backends produce H.264
 * Annex-B access units (standalone SPS/PPS packets flagged isConfig) and
 * consume normalized 0..1 gestures, so the middleware and the browser client
 * are identical for both.
 */
export type EmuSession = {
  transport: EmuBackend;
  serial: string;
  meta: ScrcpyMeta;
  readFrame: () => Promise<VideoFrame | null>;
  sendGesture: (gesture: Gesture) => Promise<void>;
  /** Ask the source for a fresh keyframe (new client joined, backpressure, stall). */
  resetVideo: () => void;
  /** Register a callback for unrecoverable session failure. */
  onFatal: (cb: (reason: string) => void) => void;
  close: () => void;
};

export function resolveBackend(explicit?: string): EmuBackend {
  const value = explicit ?? process.env.SERVE_EMU_BACKEND ?? "scrcpy";
  if (value === "scrcpy" || value === "grpc") return value;
  console.warn(`serve-emu: unknown backend "${value}" (expected "scrcpy" or "grpc"); using scrcpy`);
  return "scrcpy";
}

export async function startSession(opts: SessionOpts): Promise<EmuSession> {
  if (resolveBackend(opts.backend) === "grpc") {
    if (/^emulator-\d+$/.test(opts.serial)) {
      try {
        const session = await startGrpcSession(opts);
        console.log(`serve-emu: ${opts.serial} streaming via grpc backend (host-side capture)`);
        return session;
      } catch (err) {
        console.warn(
          `serve-emu: grpc backend failed for ${opts.serial} (${err instanceof Error ? err.message : err}); falling back to scrcpy`,
        );
      }
    }
    // Physical devices have no host-side framebuffer; scrcpy is the only option.
  }
  return startScrcpySession(opts);
}

async function startScrcpySession(opts: StartOpts): Promise<EmuSession> {
  const session = await startScrcpy(opts);
  const screen: Screen = { width: session.meta.width, height: session.meta.height };
  const fatalCbs: ((reason: string) => void)[] = [];
  session.proc.once("exit", (code, signal) => {
    for (const cb of fatalCbs) cb(`scrcpy exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
  });
  session.controlSocket.once("error", (err) => {
    for (const cb of fatalCbs) cb(`scrcpy control socket error: ${err.message}`);
  });
  return {
    transport: "scrcpy",
    serial: opts.serial,
    meta: session.meta,
    readFrame: session.readFrame,
    sendGesture: (gesture) => dispatch(session.controlSocket, gesture, screen),
    resetVideo: () => {
      try {
        session.controlSocket.write(resetVideoPacket());
      } catch {}
    },
    onFatal: (cb) => {
      fatalCbs.push(cb);
    },
    close: session.close,
  };
}
