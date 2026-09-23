import { execSync } from "child_process";
import { readFileSync } from "fs";
import { sleepSync } from "./runtime";
import { listStateFiles, type ServeSimDeviceState } from "./state";

/**
 * Pids this server recorded for itself while serving a given port.
 *
 * Ownership is read from serve-sim's own state files rather than inferred from `ps` output. A
 * command line is argv joined by spaces with no quoting, so a path containing a space cannot be
 * split back out, and a path argument that merely ends in "serve-sim" is indistinguishable from
 * the program itself. The state file is written by the process it describes, so it answers the
 * question directly.
 */
function recordedPidsForPort(port: number): Set<number> {
  const pids = new Set<number>();
  for (const file of listStateFiles()) {
    try {
      const state = JSON.parse(readFileSync(file, "utf-8")) as Partial<ServeSimDeviceState>;
      // The port has to match too: a state file outlives a SIGKILLed server, and the kernel
      // reuses pids.
      if (typeof state.pid === "number" && state.port === port) pids.add(state.pid);
    } catch {}
  }
  return pids;
}

/**
 * Pids listening on a TCP port that a serve-sim server recorded for that port, never this process.
 * A foreign listener is named in the log and left out of the result.
 *
 * The LISTEN filter is load-bearing: a bare `lsof -ti tcp:<port>` also lists processes holding
 * *client* sockets to the port — most notably the user's browser streaming MJPEG from a previous
 * helper. Killing those SIGKILLs the browser's network process, which aborts every in-flight fetch
 * in the new preview tab and surfaces as "Stream is not producing frames".
 */
export function findOwnListeners(port: number): number[] {
  try {
    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (!output) return [];
    const recorded = recordedPidsForPort(port);
    const listeners = output
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
    const ours = listeners.filter((pid) => recorded.has(pid));
    // Refusing is the safe answer, but it leaves the caller with a port it cannot have. Name the
    // holder, or the failure surfaces later as a bind error with nothing to explain it. PID only,
    // never the command line: this stdout reaches the preview page through `server.detach`, and a
    // foreign argv can carry a secret such as a tunnel's auth token.
    if (listeners.length > 0 && ours.length === 0) {
      console.log(
        `\x1b[90mPort ${port} is held by pid(s) ${listeners.join(", ")}, which serve-sim did not start\x1b[0m`,
      );
    }
    return ours;
  } catch {
    return [];
  }
}

/** Kills the serve-sim listeners findOwnListeners reports; a foreign holder keeps the port. */
export function killOwnListeners(port: number): void {
  const pids = findOwnListeners(port);
  if (pids.length === 0) return;
  console.log(`\x1b[90mPort ${port} busy, killing listener pid(s): ${pids.join(", ")}\x1b[0m`);
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  sleepSync(100);
}
