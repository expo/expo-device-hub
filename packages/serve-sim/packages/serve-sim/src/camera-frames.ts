import { existsSync } from "fs";
import net from "net";

import { cameraHelperSocketFile } from "./camera-helper";

const HANDSHAKE_TIMEOUT_MS = 3_000;
const IDLE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_BYTES = 4096;
export const MAX_CAMERA_FRAME_BYTES = 8 * 1024 * 1024;

interface FrameStream {
  udid: string;
  socket: net.Socket;
  ready: boolean;
  draining: boolean;
  idle: ReturnType<typeof setTimeout>;
  handshake: ReturnType<typeof setTimeout>;
}

const streams = new Map<string, FrameStream>();
const claims = new Map<string, symbol>();
// Stops a reconnect on every frame once the helper has left the stream source.
const refused = new Set<string>();

function drop(stream: FrameStream): void {
  if (streams.get(stream.udid) === stream) streams.delete(stream.udid);
  clearTimeout(stream.idle);
  clearTimeout(stream.handshake);
  stream.socket.destroy();
}

function openStream(udid: string): FrameStream | null {
  const socketPath = cameraHelperSocketFile(udid);
  if (!existsSync(socketPath)) return null;

  const socket = net.createConnection(socketPath);
  const stream: FrameStream = {
    udid,
    socket,
    ready: false,
    draining: false,
    idle: setTimeout(() => drop(stream), IDLE_TIMEOUT_MS),
    handshake: setTimeout(() => drop(stream), HANDSHAKE_TIMEOUT_MS),
  };
  stream.idle.unref();
  stream.handshake.unref();
  streams.set(udid, stream);

  socket.once("connect", () => {
    socket.write(`${JSON.stringify({ action: "frames" })}\n`);
  });
  let handshake = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    if (stream.ready) return;
    if (handshake.length + chunk.length > MAX_HANDSHAKE_BYTES) {
      drop(stream);
      return;
    }
    handshake = Buffer.concat([handshake, chunk]);
    const newline = handshake.indexOf(10);
    if (newline < 0) return;
    let reply: unknown;
    try {
      reply = JSON.parse(handshake.toString("utf8", 0, newline));
    } catch {
      drop(stream);
      return;
    }
    if (reply && typeof reply === "object" && "ok" in reply && reply.ok === true) {
      clearTimeout(stream.handshake);
      handshake = Buffer.alloc(0);
      stream.ready = true;
    } else {
      refused.add(udid);
      drop(stream);
    }
  });
  socket.on("drain", () => {
    stream.draining = false;
  });
  socket.on("error", () => drop(stream));
  socket.on("close", () => drop(stream));
  return stream;
}

export function claimCameraFrameStream(udid: string, owner: symbol): void {
  closeCameraFrameStream(udid);
  refused.delete(udid);
  claims.set(udid, owner);
}

/** A stream source claims the feed for the socket that set it; any other source ends the claim. */
export function applyCameraActionResult(
  action: string,
  params: Record<string, unknown> | undefined,
  result: { exitCode: number },
  owner: symbol | null,
): void {
  if (result.exitCode !== 0 || typeof params?.udid !== "string") return;
  if (action !== "camera.inject" && action !== "camera.switch" && action !== "camera.stopWebcam") return;
  if (action === "camera.stopWebcam" || params.source !== "stream") {
    closeCameraFrameStream(params.udid);
  } else if (owner) {
    claimCameraFrameStream(params.udid, owner);
  }
}

/** The helper is gone or refused the stream. A full socket is only a temporary drop. */
export function cameraFrameStreamLost(udid: string): boolean {
  return refused.has(udid) || !existsSync(cameraHelperSocketFile(udid));
}

export function closeCameraFrameStream(udid: string, owner?: symbol): void {
  if (owner !== undefined && claims.get(udid) !== owner) return;
  claims.delete(udid);
  const stream = streams.get(udid);
  if (stream) drop(stream);
}

export function closeCameraFrameStreams(owner: symbol): void {
  for (const [udid, claimant] of claims) {
    if (claimant === owner) closeCameraFrameStream(udid, owner);
  }
}

export function ownsCameraFrameStream(udid: string, owner: symbol): boolean {
  return claims.get(udid) === owner;
}

export function writeCameraFrame(udid: string, frame: Buffer, owner: symbol): boolean {
  if (!ownsCameraFrameStream(udid, owner) || frame.length === 0 || frame.length > MAX_CAMERA_FRAME_BYTES) return false;
  if (refused.has(udid)) return false;
  const stream = streams.get(udid) ?? openStream(udid);
  if (!stream) return false;

  // Keep at most one frame in the socket's write queue. A helper that stops reading idles out.
  if (!stream.ready || stream.draining) return false;
  clearTimeout(stream.idle);
  stream.idle = setTimeout(() => drop(stream), IDLE_TIMEOUT_MS);
  stream.idle.unref();
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(frame.length, 0);
  stream.draining = !stream.socket.write(Buffer.concat([header, frame]));
  return true;
}
