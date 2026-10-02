import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { recordingShutdownFailureFile, type ServeSimDeviceState } from "./state";

const SHUTDOWN_GRACE_MS = 500;
const RECORDING_SHUTDOWN_GRACE_MS = 65_000;
type StopResult = { exitCode: number | null; signalCode: NodeJS.Signals | null; forced: boolean };

function result(child: ChildProcess | undefined, forced: boolean): StopResult {
  return { exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, forced };
}

function hasExited(pid: number, child?: ChildProcess): boolean {
  if (child) return child.exitCode !== null || child.signalCode !== null;
  try { process.kill(pid, 0); return false; } catch { return true; }
}

async function waitForExit(pid: number, child: ChildProcess | undefined, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited(pid, child)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return hasExited(pid, child);
}

/** A healthy active recording may need the native recorder's 60-second finalization window. */
export async function recordingShutdownGraceMs(url: string, token?: string): Promise<number> {
  try {
    const response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return SHUTDOWN_GRACE_MS;
    const status = await response.json() as { active?: unknown };
    return status.active === true ? RECORDING_SHUTDOWN_GRACE_MS : SHUTDOWN_GRACE_MS;
  } catch {
    return SHUTDOWN_GRACE_MS;
  }
}

/** Stop an existing helper before changing stream settings, preserving active recordings. */
export async function stopForStreamReplacement(state: ServeSimDeviceState): Promise<{
  forced: boolean;
  recordingError?: string;
}> {
  const failureFile = recordingShutdownFailureFile(state.pid);
  try { unlinkSync(failureFile); } catch {}
  const graceMs = await recordingShutdownGraceMs(
    state.streamUrl.replace(/\/stream\.mjpeg$/, "/recording/video"), state.token,
  );
  const result = await stopProcess(state.pid, undefined, graceMs);
  if (!hasExited(state.pid)) {
    throw new Error(`Previous serve-sim helper ${state.pid} is still running; cannot replace it`);
  }
  let reportedFailure: string | undefined;
  if (existsSync(failureFile)) {
    try {
      const report = JSON.parse(readFileSync(failureFile, "utf8")) as { errors?: unknown };
      reportedFailure = Array.isArray(report.errors)
        ? report.errors.map(String).join("; ") || "Recording finalization failed"
        : "Recording finalization failed";
    } catch {
      reportedFailure = "Recording finalization failed";
    }
  }
  if (reportedFailure) {
    try { unlinkSync(failureFile); } catch {}
  }
  return {
    forced: result.forced,
    recordingError: reportedFailure ?? (graceMs === RECORDING_SHUTDOWN_GRACE_MS && result.forced
      ? "Active recording was interrupted when the helper required SIGKILL" : undefined),
  };
}

/** Give the server a short chance to exit before forcing an unresponsive helper down. */
export async function stopProcess(
  pid: number,
  child?: ChildProcess,
  graceMs = SHUTDOWN_GRACE_MS,
): Promise<StopResult> {
  if (hasExited(pid, child)) return result(child, false);
  try { process.kill(pid, "SIGTERM"); } catch { return result(child, false); }
  if (await waitForExit(pid, child, graceMs)) {
    return result(child, false);
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  await waitForExit(pid, child, 1_000);
  return result(child, true);
}
