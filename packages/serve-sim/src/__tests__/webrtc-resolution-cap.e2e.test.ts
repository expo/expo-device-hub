import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { execSync } from "child_process";
import { existsSync } from "fs";
import net from "net";
import { join } from "path";
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";

// The assertion is the cap, not an exact size: libwebrtc lowers resolution further under CPU or
// bandwidth pressure, so two sessions on a loaded machine legitimately differ.
// Reads the resolution the encoder actually negotiated, off the wire, by acting
// as a real receiving peer. `--max-dimension` is enforced on the WebRTC path
// only through the sender's `scaleResolutionDownBy`, which is not signalled in
// SDP and not reported by any endpoint — so a second peer is the only way to
// observe it. The second session is the one that matters: the publisher's
// re-apply is gated on a source size change, so a regression there leaves the
// first viewer capped and every later one at native resolution.

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const MAX_DIMENSION = 1280;

function bootedUdid(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!/iOS/i.test(runtime)) continue;
      for (const d of devices) if (d.state === "Booted") return d.udid;
    }
  } catch {}
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function readKeyframeDimensions(payload: Buffer): { width: number; height: number } | null {
  // VP8 keyframes carry their dimensions right after the 0x9d 0x01 0x2a start
  // code, as two 14-bit little-endian values. The payload descriptor ahead of it
  // is variable length, so scan rather than compute an offset.
  const limit = Math.min(payload.length - 7, 24);
  for (let i = 0; i < limit; i += 1) {
    if (payload[i] === 0x9d && payload[i + 1] === 0x01 && payload[i + 2] === 0x2a) {
      const width = ((payload[i + 4]! << 8) | payload[i + 3]!) & 0x3fff;
      const height = ((payload[i + 6]! << 8) | payload[i + 5]!) & 0x3fff;
      if (width > 0 && height > 0) return { width, height };
    }
  }
  return null;
}

async function negotiateAndMeasure(offerUrl: string): Promise<{ width: number; height: number }> {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, payloadType: 96 })],
    },
  });
  try {
    const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
    let rtpSeen = 0;
    const measured = new Promise<{ width: number; height: number }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no VP8 keyframe arrived (rtp packets seen: ${rtpSeen})`)),
        25_000,
      );
      transceiver.onTrack.subscribe((track) => {
        track.onReceiveRtp.subscribe((rtp) => {
          rtpSeen += 1;
          const dimensions = readKeyframeDimensions(rtp.payload);
          if (dimensions) {
            clearTimeout(timer);
            resolve(dimensions);
          }
        });
      });
    });

    await pc.setLocalDescription(await pc.createOffer());
    const response = await fetch(offerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "offer",
        sdp: pc.localDescription!.sdp,
        sessionId: crypto.randomUUID(),
        codec: "vp8",
      }),
    });
    if (!response.ok) {
      throw new Error(`offer rejected: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    const answer = (await response.json()) as { sdp: string };
    await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    return await measured;
  } finally {
    pc.close();
  }
}

const udid = bootedUdid();
const describeIfSim = udid && existsSync(CLI) ? describe : describe.skip;

describeIfSim("WebRTC resolution cap", () => {
  let server: ChildProcess | null = null;
  let offerUrl = "";
  let serverOutput = "";

  beforeAll(async () => {
    const port = await freePort();
    offerUrl = `http://127.0.0.1:${port}/helper/${udid}/webrtc/offer`;
    server = spawn(
      "node",
      [
        CLI,
        "--no-preview",
        "--port", String(port),
        "--transport", "webrtc",
        "--webrtc-codec", "vp8",
        "--max-dimension", String(MAX_DIMENSION),
        "--video-bitrate", "3000000",
        "--video-fps", "60",
        udid!,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    server.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
    server.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });

    const ready = await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
      } catch {
        return false;
      }
    }, 60_000);
    if (!ready) {
      throw new Error(`serve-sim never became ready\noutput:\n${serverOutput.slice(0, 800)}`);
    }
  }, 70_000);

  afterAll(() => {
    server?.kill("SIGTERM");
  });

  test("caps every session, not only the first", async () => {
    const first = await negotiateAndMeasure(offerUrl);
    expect(Math.max(first.width, first.height)).toBeLessThanOrEqual(MAX_DIMENSION);

    const second = await negotiateAndMeasure(offerUrl);
    expect(Math.max(second.width, second.height)).toBeLessThanOrEqual(MAX_DIMENSION);
  }, 90_000);
});
