import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { execSync } from "child_process";
import { existsSync } from "fs";
import net from "net";
import { join } from "path";
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";

// Regression test for the frame pump's cadence. A production trace showed the
// pump silently degrading to send-on-arrival on virtualized hosts: over a 55 s
// session it repeated the retained frame only 202 times instead of filling the
// configured 60 fps (forwarded ≈ offered). With the pump healthy, forwarded
// frames run at ~60/s while an idle simulator offers only the ~5 fps capture
// floor. The threshold is deliberately loose: a dead pump measures at capture
// rate (5-20/s), a live one at 50+/s, so 30/s separates them with margin on a
// loaded CI host.

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");

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

type CaptureCounts = {
  offeredFrames?: number;
  forwardedFrames?: number;
  pumpRestarts?: number;
};

const udid = bootedUdid();
const describeIfSim = udid && existsSync(CLI) ? describe : describe.skip;

describeIfSim("WebRTC frame pump cadence", () => {
  let server: ChildProcess | null = null;
  let baseUrl = "";
  let serverOutput = "";

  async function captureCounts(): Promise<CaptureCounts> {
    const response = await fetch(`${baseUrl}/helper/${udid}/webrtc/stats`);
    if (!response.ok) throw new Error(`stats unavailable: ${response.status}`);
    const body = (await response.json()) as { capture?: CaptureCounts };
    return body.capture ?? {};
  }

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(
      "node",
      [
        CLI,
        "--no-preview",
        "--port", String(port),
        "--transport", "webrtc",
        "--webrtc-codec", "vp8",
        "--max-dimension", "1280",
        "--video-fps", "60",
        udid!,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    server.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });
    server.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString(); });

    const ready = await waitFor(async () => {
      try {
        return (await fetch(`${baseUrl}/healthz`)).ok;
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

  test("the pump repeats the retained frame at the configured rate", async () => {
    const pc = new RTCPeerConnection({
      codecs: {
        video: [new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, payloadType: 96 })],
      },
    });
    try {
      const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
      let rtpSeen = 0;
      transceiver.onTrack.subscribe((track) => {
        track.onReceiveRtp.subscribe(() => { rtpSeen += 1; });
      });
      await pc.setLocalDescription(await pc.createOffer());
      const response = await fetch(`${baseUrl}/helper/${udid}/webrtc/offer`, {
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

      // Media must actually be flowing before the measurement window starts.
      const streaming = await waitFor(() => rtpSeen > 10, 25_000);
      if (!streaming) throw new Error(`no RTP arrived\nserver output:\n${serverOutput.slice(-1_000)}`);

      const before = await captureCounts();
      await new Promise((r) => setTimeout(r, 4_000));
      const after = await captureCounts();

      const forwardedPerSecond = ((after.forwardedFrames ?? 0) - (before.forwardedFrames ?? 0)) / 4;
      const offeredPerSecond = ((after.offeredFrames ?? 0) - (before.offeredFrames ?? 0)) / 4;
      // A dead pump tracks the capture rate; a live one fills toward 60/s.
      expect(forwardedPerSecond).toBeGreaterThanOrEqual(30);
      // Sanity: the counters really are decoupled — repeats happen even when
      // capture offers little. Skipped if something animates the simulator at
      // full rate, where the two rates legitimately converge.
      if (offeredPerSecond < 25) {
        expect(forwardedPerSecond).toBeGreaterThan(offeredPerSecond);
      }
    } finally {
      pc.close();
    }
  }, 90_000);
});
