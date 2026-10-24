import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";

import { sendHingeAngleToWs } from "../hinge-command";
import { inProcessServeSimState } from "../state";
import { restoreHingeState, selectPose, waitForHingeConfig } from "./duo-hinge-helpers";
import { freePortAsync } from "./helpers";

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

async function waitFor(
  check: () => boolean | Promise<boolean>,
  budgetMs: number,
): Promise<boolean> {
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

const udid = e2eDevice();
const isDuo =
  udid &&
  Object.values(
    JSON.parse(
      execFileSync("xcrun", ["simctl", "list", "devices", "-j"], {
        encoding: "utf8",
        timeout: 30_000,
      }),
    ).devices as Record<string, { udid: string; deviceTypeIdentifier?: string }[]>,
  )
    .flat()
    .some((device) => device.udid === udid && device.deviceTypeIdentifier?.endsWith(".iPhone-Duo"));
const describeIfSim = udid && existsSync(CLI) ? describe : describe.skip;
requireE2E("webrtc-pacer.e2e", Boolean(udid && existsSync(CLI)));

describeIfSim("WebRTC frame pump cadence", () => {
  let server: ChildProcess | null = null;
  let baseUrl = "";
  let serverOutput = "";

  async function captureCounts(panel = ""): Promise<CaptureCounts> {
    const response = await fetch(`${baseUrl}/helper/${udid}${panel}/webrtc/stats`);
    if (!response.ok) throw new Error(`stats unavailable: ${response.status}`);
    const body = (await response.json()) as { capture?: CaptureCounts };
    return body.capture ?? {};
  }

  beforeAll(async () => {
    const port = await freePortAsync();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(
      "node",
      [
        CLI,
        "--no-preview",
        "--port",
        String(port),
        "--transport",
        "webrtc",
        "--webrtc-codec",
        "vp8",
        "--max-dimension",
        "1280",
        "--video-fps",
        "60",
        udid!,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    server.stdout?.on("data", (chunk: Buffer) => {
      serverOutput += chunk.toString();
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      serverOutput += chunk.toString();
    });

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

  async function connect(panel = ""): Promise<RTCPeerConnection> {
    const pc = new RTCPeerConnection({
      codecs: {
        video: [
          new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, payloadType: 96 }),
        ],
      },
    });
    try {
      const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
      let rtpSeen = 0;
      transceiver.onTrack.subscribe((track) => {
        track.onReceiveRtp.subscribe(() => {
          rtpSeen += 1;
        });
      });
      await pc.setLocalDescription(await pc.createOffer());
      const response = await fetch(`${baseUrl}/helper/${udid}${panel}/webrtc/offer`, {
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
        throw new Error(
          `offer rejected: ${response.status} ${(await response.text()).slice(0, 200)}`,
        );
      }
      const answer = (await response.json()) as { sdp: string };
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });

      // Media must actually be flowing before the measurement window starts.
      const streaming = await waitFor(() => rtpSeen > 10, 25_000);
      if (!streaming)
        throw new Error(`no RTP arrived\nserver output:\n${serverOutput.slice(-1_000)}`);

      return pc;
    } catch (error) {
      pc.close();
      throw error;
    }
  }

  test("the pump repeats the retained frame at the configured rate", async () => {
    const pc = await connect();
    try {
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

  test.skipIf(!isDuo)(
    "both connected Duo panels follow active-display handoffs",
    async () => {
      const panels = ["/panel/1", "/panel/3"];
      const peers: RTCPeerConnection[] = [];
      const state = inProcessServeSimState(udid!, Number(new URL(baseUrl).port));
      const ws = state.wsUrl;
      const config = async () => {
        const response = await fetch(`${baseUrl}/helper/${udid}/config`);
        if (!response.ok) throw new Error(`config unavailable: ${response.status}`);
        return (await response.json()) as { screenId?: number; hingeAngle?: number };
      };
      const original = await waitForHingeConfig(state, { supportsHingeAngle: true });
      expect(
        original.physicalOrientation === "portrait" || Boolean(original.hingePose),
        "handoff needs portrait or a known preset so cleanup can restore orientation",
      ).toBe(true);
      try {
        if (original.hingePose) await selectPose(state, "book");
        for (const panel of panels) peers.push(await connect(panel));
        // CoreDevice elects inner panel 3 when open, outer panel 1 when closed.
        for (const [angle, active] of [
          [180, 3],
          [0, 1],
          [180, 3],
        ] as const) {
          await sendHingeAngleToWs(ws, angle);
          const elected = await waitFor(async () => {
            const current = await config();
            return (
              current.screenId === active &&
              current.hingeAngle !== undefined &&
              Math.abs(current.hingeAngle - angle) <= 1
            );
          }, 10_000);
          expect(elected, `no active-display handoff at hinge angle ${angle}`).toBe(true);
          // Allow an in-flight resize and the next activity observation to settle.
          await Bun.sleep(1_000);
          const before = await Promise.all(panels.map(captureCounts));
          const started = performance.now();
          await Bun.sleep(2_000);
          const after = await Promise.all(panels.map(captureCounts));
          const seconds = (performance.now() - started) / 1000;
          const rates = after.map((counts, index) => {
            expect(counts.forwardedFrames).toBeNumber();
            expect(before[index]!.forwardedFrames).toBeNumber();
            return (counts.forwardedFrames! - before[index]!.forwardedFrames!) / seconds;
          });
          console.log(
            `Duo angle=${angle} active=${active} panel1=${rates[0]!.toFixed(1)} panel3=${rates[1]!.toFixed(1)} submissions/s`,
          );
          for (let index = 0; index < panels.length; index++) {
            if (panels[index] === `/panel/${active}`)
              expect(rates[index]!).toBeGreaterThanOrEqual(30);
            else {
              expect(rates[index]!).toBeGreaterThanOrEqual(2);
              expect(rates[index]!).toBeLessThanOrEqual(8);
            }
          }
        }
      } finally {
        try {
          await restoreHingeState(state, original);
        } finally {
          for (const peer of peers) peer.close();
        }
      }
    },
    120_000,
  );
});
