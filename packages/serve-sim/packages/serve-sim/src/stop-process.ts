import type { ChildProcess } from "node:child_process";

const RECORDING_SHUTDOWN_GRACE_MS = 75_000;
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

/** Give the server time to finalize MP4 files before forcing it to exit. */
export async function stopProcess(
  pid: number,
  child?: ChildProcess,
  graceMs = RECORDING_SHUTDOWN_GRACE_MS,
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
