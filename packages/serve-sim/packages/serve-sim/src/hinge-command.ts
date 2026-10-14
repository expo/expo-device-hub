import WebSocket from "ws";
import { isHingeAngle, type HingeAngleResult } from "./hinge-angle";
import type { HingePhysicalOrientation, HingePose } from "./hinge-control";

/** Resolve only after the native hinge operation has been acknowledged. */
export async function sendHingeAngleToWs(
  wsUrl: string,
  angle: number,
  options: { token?: string; timeoutMs?: number } = {},
): Promise<void> {
  if (!isHingeAngle(angle)) throw new Error("Hinge angle must be between 0–180 degrees");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for hinge control acknowledgement")), options.timeoutMs ?? 5000);
    ws.on("open", () => {
      ws.send(Buffer.concat([Buffer.from([0x0f]), Buffer.from(JSON.stringify({ angle }))]));
    });
    ws.on("message", (data) => {
      const frame = Buffer.from(data as Buffer);
      if (frame[0] !== 0x8f) return;
      let reply: HingeAngleResult;
      try { reply = JSON.parse(frame.subarray(1).toString()); }
      catch { finish(new Error("Invalid hinge control acknowledgement")); return; }
      if (!reply || typeof reply !== "object" || typeof reply.ok !== "boolean") {
        finish(new Error("Invalid hinge control acknowledgement"));
        return;
      }
      if (!reply.ok) finish(new Error(reply.error || "Hinge control is unavailable on this simulator"));
      else if (reply.angle === angle) finish();
      else finish(new Error("Server acknowledged a different hinge angle"));
    });
    ws.on("error", (error) => finish(new Error(`Hinge control connection failed: ${error.message}`)));
    ws.on("close", () => finish(new Error("Connection closed before hinge control acknowledgement")));
  });
}

export type HingeStateReport = {
  hingeAngle?: number;
  hingePose?: HingePose | null;
  physicalOrientation?: HingePhysicalOrientation;
  tableMode?: boolean;
  tableModeAvailable?: boolean;
};

/** Resolve with the server's confirmed hinge state once it has probed the simulator. */
export async function readHingeStateFromWs(
  wsUrl: string,
  options: { token?: string; timeoutMs?: number } = {},
): Promise<HingeStateReport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
    });
    let settled = false;
    const finish = (result: HingeStateReport | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for the simulator's hinge state")), options.timeoutMs ?? 5000);
    ws.on("message", (data) => {
      const frame = Buffer.from(data as Buffer);
      if (frame[0] !== 0x82) return;
      let config: HingeStateReport & { supportsHingeAngle?: boolean };
      try { config = JSON.parse(frame.subarray(1).toString()); }
      catch { finish(new Error("Invalid screen config from the serve-sim server")); return; }
      if (config.supportsHingeAngle === undefined) return;
      if (!config.supportsHingeAngle) {
        finish(new Error("Hinge control is unavailable on this simulator"));
        return;
      }
      const { hingeAngle, hingePose, physicalOrientation, tableMode, tableModeAvailable } = config;
      finish({ hingeAngle, hingePose, physicalOrientation, tableMode, tableModeAvailable });
    });
    ws.on("error", (error) => finish(new Error(`Hinge state connection failed: ${error.message}`)));
    ws.on("close", () => finish(new Error("Connection closed before the hinge state arrived")));
  });
}
