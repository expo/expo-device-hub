import type { ChildProcess } from "node:child_process";

const RECORDING_SHUTDOWN_GRACE_MS = 75_000;

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
): Promise<{ exitCode: number | null; forced: boolean }> {
  if (hasExited(pid, child)) return { exitCode: child?.exitCode ?? null, forced: false };
  try { process.kill(pid, "SIGTERM"); } catch { return { exitCode: child?.exitCode ?? null, forced: false }; }
  if (await waitForExit(pid, child, graceMs)) {
    return { exitCode: child?.exitCode ?? null, forced: false };
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  await waitForExit(pid, child, 1_000);
  return { exitCode: child?.exitCode ?? null, forced: true };
}
