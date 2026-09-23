import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import WebSocket from "ws";
import { stateFileForDevice, type ServeSimDeviceState } from "../state";
import type { HingePose } from "../hinge-control";

// Opt in against a rebuilt running server and a booted Duo with a landscape-
// capable app (Safari or fixtures/duo). This changes the device's physical pose.
const device = process.env.SERVE_SIM_DUO_E2E_DEVICE;

async function selectPose(state: ServeSimDeviceState, value: HingePose) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(state.wsUrl, {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
    });
    const timeout = setTimeout(() => finish(new Error("Pose acknowledgement timed out")), 5000);
    let settled = false;
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error); else resolve();
    }
    socket.on("error", finish);
    socket.on("close", () => finish(new Error("Pose connection closed before acknowledgement")));
    socket.on("open", () => socket.send(Buffer.concat([
      Buffer.from([0x10]), Buffer.from(JSON.stringify({ requestId: 1, command: { control: "pose", value } })),
    ])));
    socket.on("message", (data) => {
      const frame = Buffer.from(data as Buffer);
      if (frame[0] !== 0x90) return;
      const reply = JSON.parse(frame.subarray(1).toString());
      finish(reply.ok ? undefined : new Error(reply.error ?? "Pose failed"));
    });
  });
}

test.skipIf(!device)("native hinge recovery reads angles changed by another process", async () => {
  const { NativeHid } = await import("../native");
  const observer = new NativeHid(device!);
  const state = JSON.parse(readFileSync(stateFileForDevice(device!), "utf8")) as ServeSimDeviceState;
  try {
    for (const [pose, angle] of [["closed", 0], ["open", 180], ["book", 90]] as const) {
      // Commands run in the server, so this process cannot use its last sent
      // angle to pass. It must receive a fresh native motion sample.
      await selectPose(state, pose);
      expect((await observer.hingeState()).hingeAngle).toBe(angle);
    }
  } finally { await selectPose(state, "tent"); }
}, 20_000);

test.skipIf(!device)("native capture notifies active panel changes without JS metadata polling", async () => {
  const { NativeCapture } = await import("../native");
  const capture = new NativeCapture(device!);
  const state = JSON.parse(readFileSync(stateFileForDevice(device!), "utf8")) as ServeSimDeviceState;
  const observed: number[] = [];
  let unsubscribe: (() => Promise<void>) | undefined;
  try {
    await capture.start();
    unsubscribe = await capture.subscribeScreenChanges(async () => {
      const config = await capture.screenSize();
      if (config.screenId !== undefined) observed.push(config.screenId);
    });
    for (const [pose, screenId] of [["open", 3], ["closed", 1], ["open", 3]] as const) {
      const start = observed.length;
      await selectPose(state, pose);
      const deadline = Date.now() + 3000;
      while (!observed.slice(start).includes(screenId) && Date.now() < deadline) await Bun.sleep(20);
      expect(observed.slice(start)).toContain(screenId);
    }
  } finally {
    await unsubscribe?.();
    await capture.stop();
    await selectPose(state, "tent");
  }
}, 20_000);

test.skipIf(!device)("Tent makes the cover landscape regardless of the previous preset", async () => {
  const state = JSON.parse(readFileSync(stateFileForDevice(device!), "utf8")) as ServeSimDeviceState;
  const configUrl = state.streamUrl.replace(/\/stream\.[^/]+$/, "/config");
  for (const previous of ["closed", "open", "book", "laptop", "tent"] as const) {
    await selectPose(state, previous);
    await selectPose(state, "tent");
    const deadline = Date.now() + 8000;
    let landscapeSince: number | undefined;
    let config;
    do {
      const response = await fetch(configUrl, {
        headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
        signal: AbortSignal.timeout(5000),
      });
      expect(response.ok).toBe(true);
      config = await response.json();
      // The active panel can initially report the previous orientation while
      // iOS finishes rotating. Require a stable readback, not its first match.
      if (config.screenId === 1 && config.orientation === "landscape_left") {
        landscapeSince ??= Date.now();
        if (Date.now() - landscapeSince >= 2000) break;
      } else landscapeSince = undefined;
      await Bun.sleep(100);
    } while (Date.now() < deadline);
    expect({ previous, ...config }).toMatchObject({
      previous, screenId: 1, orientation: "landscape_left", hingeAngle: 80, hingePose: "tent", tableMode: true,
    });
    expect(landscapeSince !== undefined && Date.now() - landscapeSince >= 2000).toBe(true);
  }
}, 60_000);
