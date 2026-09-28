import type { ChildProcess } from "node:child_process";

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
