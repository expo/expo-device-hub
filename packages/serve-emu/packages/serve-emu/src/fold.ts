import { setTimeout as sleep } from "node:timers/promises";
import { readEmuConsoleValue } from "./adb.ts";
import { isEmulatorSerial } from "./device-capabilities.ts";
import { execText } from "./exec.ts";
import type { FoldPosture, FoldStatus } from "./shared/api-contracts.ts";

const POSTURES: Record<string, FoldPosture> = {
  CLOSED: "closed",
  HALF_OPENED: "half_opened",
  OPENED: "opened",
  REAR_DISPLAY_MODE: "flipped",
};

const UNSUPPORTED: FoldStatus = { supported: false, posture: null, hingeAngle: null };

export async function getFoldStatus(
  serial: string,
  runExec: typeof execText = execText,
): Promise<FoldStatus> {
  if (!isEmulatorSerial(serial)) return UNSUPPORTED;

  const hinge = await readEmuConsoleValue(serial, ["sensor", "get", "hinge-angle0"], runExec);
  const angle = Number(hinge?.match(/^hinge-angle0\s*=\s*(-?\d+(?:\.\d+)?)$/)?.[1]);
  if (!hinge || !Number.isFinite(angle)) return UNSUPPORTED;

  const state = await runExec(
    "adb",
    ["-s", serial, "shell", "cmd", "device_state", "base-state"],
    { timeout: 5_000, lane: "interactive" },
  );
  const name = state.status === 0
    ? state.stdout.match(/name='([A-Z_]+)'/)?.[1]
    : undefined;
  const posture = name ? POSTURES[name] : undefined;
  return {
    supported: true,
    posture: posture ?? (angle <= 5 ? "closed" : angle >= 175 ? "opened" : null),
    hingeAngle: angle,
  };
}

export async function setFoldPosture(
  serial: string,
  posture: "closed" | "opened",
  runExec: typeof execText = execText,
): Promise<FoldStatus> {
  const current = await getFoldStatus(serial, runExec);
  if (!current.supported) throw new Error("Selected emulator does not support folding");

  const command = posture === "closed" ? "fold" : "unfold";
  const result = await runExec("adb", ["-s", serial, "emu", command], {
    timeout: 5_000,
    lane: "interactive",
  });
  if (result.status !== 0 || result.timedOut || result.error || /\bKO:/.test(result.stdout)) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error";
    throw new Error(`Emulator ${command} failed: ${detail}`);
  }

  const deadline = Date.now() + 2_000;
  let status = await getFoldStatus(serial, runExec);
  while (status.posture !== posture && Date.now() < deadline) {
    await sleep(50);
    status = await getFoldStatus(serial, runExec);
  }
  if (status.posture !== posture) throw new Error(`Emulator did not confirm ${posture} posture`);
  return status;
}
