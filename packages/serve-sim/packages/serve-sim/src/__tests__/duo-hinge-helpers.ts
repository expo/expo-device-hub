import WebSocket from "ws";
import type { ServeSimDeviceState } from "../state";
import type { HingeControlCommand, HingeControlState, HingePose } from "../hinge-control";

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
      if (error) reject(error); else resolve();
    }
    socket.on("error", finish);
    socket.on("close", () => finish(new Error("Hinge connection closed before acknowledgement")));
    socket.on("open", () => socket.send(Buffer.concat([
      Buffer.from([0x10]), Buffer.from(JSON.stringify({ requestId: 1, command })),
    ])));
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

export async function restoreHingeState(state: ServeSimDeviceState, original: HingeControlState) {
  if (original.hingePose) {
    await selectPose(state, original.hingePose);
  } else {
    if (original.hingeAngle !== undefined) {
      await selectHingeControl(state, { control: "angle", value: original.hingeAngle });
    }
    if (original.tableMode !== undefined) {
      await selectHingeControl(state, { control: "table", value: original.tableMode });
    }
  }
}
