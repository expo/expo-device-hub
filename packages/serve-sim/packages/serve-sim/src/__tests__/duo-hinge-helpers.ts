import WebSocket from "ws";
import { readFileSync } from "fs";
import { stateFileForDevice, type ServeSimDeviceState } from "../state";
import {
  HINGE_POSES,
  hingePoseOrientation,
  type HingeControlCommand,
  type HingeControlState,
  type HingePose,
} from "../hinge-control";
import type { NativeHingeState, NativeHid } from "../native";
import type { StreamConfig } from "../client/types";
import { previewScreenConfig } from "../client/simulator/screen-config-state";

export async function selectHingeControl(state: ServeSimDeviceState, command: HingeControlCommand) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(state.wsUrl, {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
    });
    const timeout = setTimeout(() => finish(new Error("Hinge acknowledgement timed out")), 5000);
    let settled = false;
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve();
    }
    socket.on("error", finish);
    socket.on("close", () => finish(new Error("Hinge connection closed before acknowledgement")));
    socket.on("open", () =>
      socket.send(
        Buffer.concat([
          Buffer.from([0x10]),
          Buffer.from(JSON.stringify({ requestId: 1, command })),
        ]),
      ),
    );
    socket.on("message", (data) => {
      const frame = Buffer.from(data as Buffer);
      if (frame[0] !== 0x90) return;
      const reply = JSON.parse(frame.subarray(1).toString());
      finish(reply.ok ? undefined : new Error(reply.error ?? "Hinge command failed"));
    });
  });
}

export function selectPose(state: ServeSimDeviceState, value: HingePose) {
  return selectHingeControl(state, { control: "pose", value });
}

export async function waitForHingeConfig(
  state: ServeSimDeviceState,
  expected: Partial<StreamConfig>,
  timeoutMs = 5000,
): Promise<StreamConfig> {
  const url = state.streamUrl.replace(/\/stream\.[^/]+$/, "/config");
  const deadline = Date.now() + timeoutMs;
  let config: StreamConfig | undefined;
  do {
    const response = await fetch(url, {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!response.ok) throw new Error(`Hinge config failed: ${response.status}`);
    config = previewScreenConfig((await response.json()) as StreamConfig);
    if (
      Object.entries(expected).every(([key, value]) =>
        key === "hingeAngle" && typeof value === "number"
          ? config!.hingeAngle !== undefined && Math.abs(config!.hingeAngle - value) <= 1
          : config![key as keyof StreamConfig] === value,
      )
    )
      return config;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error(
    `hinge did not settle to ${JSON.stringify(expected)}; last ${JSON.stringify(config)}`,
  );
}

type RestorableHingeState = HingeControlState & Pick<NativeHingeState, "physicalOrientation">;
type HingeRestorer = Pick<
  NativeHid,
  "setHingePose" | "setHingeAngle" | "setPhysicalOrientation" | "setTableMode"
>;

async function restoreNativeHingeState(
  device: string,
  original: RestorableHingeState,
  restoreHid?: HingeRestorer,
) {
  // The test changes native state directly, without altering the helper's
  // pose history. Restore the same way, including if its socket is unavailable.
  const hid = restoreHid ?? new (await import("../native")).NativeHid(device);
  const restored = original.hingePose
    ? await hid.setHingePose(original.hingePose)
    : [
        await hid.setHingeAngle(original.hingeAngle!),
        await hid.setPhysicalOrientation(original.physicalOrientation!),
        await hid.setTableMode(original.tableMode!),
      ].every(Boolean);
  if (!restored) throw new Error("Could not restore the Duo's original hinge state");
}

export async function restoreHingeState(state: ServeSimDeviceState, original: HingeControlState) {
  const preset = HINGE_POSES.find((pose) => pose.id === original.hingePose);
  if (preset) {
    await selectPose(state, preset.id);
    await waitForHingeConfig(state, {
      hingeAngle: preset.angle,
      physicalOrientation: hingePoseOrientation(preset.id),
      tableMode: preset.id === "tent",
    });
  }
  if (original.hingeAngle !== undefined && original.hingeAngle !== preset?.angle) {
    await selectHingeControl(state, { control: "angle", value: original.hingeAngle });
    await waitForHingeConfig(state, { hingeAngle: original.hingeAngle });
  }
  if (original.tableMode !== undefined) {
    await selectHingeControl(state, { control: "table", value: original.tableMode });
    await waitForHingeConfig(state, { tableMode: original.tableMode });
  }
}

/** Preserve the running helper's pose history before a fresh native process changes the device. */
export async function withRestoredDuoHinge(
  device: string,
  run: () => Promise<void>,
  restoreHid?: HingeRestorer,
) {
  // Never discover a server through the shared default state folder.
  if (!process.env.SERVE_SIM_STATE_DIR)
    throw new Error("Set SERVE_SIM_STATE_DIR to your running Duo helper's private state directory");
  const state = JSON.parse(readFileSync(stateFileForDevice(device), "utf8")) as ServeSimDeviceState;
  if (state.device !== device) throw new Error("Duo helper state belongs to a different device");
  const response = await fetch(state.streamUrl.replace(/\/stream\.[^/]+$/, "/config"), {
    headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Could not snapshot the Duo's hinge state: ${response.status}`);
  const original = (await response.json()) as RestorableHingeState;
  // Native angle readback alone cannot recover the original gravity/table
  // state. Refuse to move the device until cleanup can restore every field.
  if (
    !original.hingePose &&
    (original.hingeAngle === undefined ||
      original.physicalOrientation === undefined ||
      original.tableMode === undefined)
  ) {
    throw new Error(
      "The Duo helper must report a known pose or complete angle, physical orientation, and Table Mode state before this test",
    );
  }
  try {
    await run();
  } finally {
    await restoreNativeHingeState(device, original, restoreHid);
  }
}
