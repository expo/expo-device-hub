import { execFileSync } from "child_process";

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `kill(pid, 0)` succeeds on a child the event loop has not reaped yet. */
export function hasProcessExited(pid: number): boolean {
  if (!isProcessAlive(pid)) return true;
  try {
    const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return state.startsWith("Z");
  } catch {
    return !isProcessAlive(pid);
  }
}
