import WebSocket from "ws";
import type { ServeSimDeviceState } from "../state";
import {
  HINGE_POSES,
  hingePoseOrientation,
  type HingeControlCommand,
  type HingeControlState,
  type HingePose,
} from "../hinge-control";
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
