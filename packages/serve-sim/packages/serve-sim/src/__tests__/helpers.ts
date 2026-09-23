import { execFileSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";

import { stateDir, stateFileForDevice } from "../state";

export const UDID = "404F2659-7202-4450-8465-912BD2AB744B";
export const EXIT_0_SHIM = "#!/bin/sh\nexit 0\n";

/** Puts throwaway executables first on PATH; `restore` puts PATH back and removes them. */
export function installShims(shims: Record<string, string>): { dir: string; restore(): void } {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-shims-"));
  for (const [name, body] of Object.entries(shims)) {
    const shim = join(dir, name);
    writeFileSync(shim, body);
    chmodSync(shim, 0o755);
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
  return {
    dir,
    restore() {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function withShimsAsync(
  shims: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const installed = installShims(shims);
  try {
    await run();
  } finally {
    installed.restore();
  }
}

/** The action deadline is read per call, so a test can shorten the shipped two minutes. */
export async function withActionTimeoutAsync(ms: number, run: () => Promise<void>): Promise<void> {
  const original = process.env.SERVE_SIM_ACTION_TIMEOUT_MS;
  process.env.SERVE_SIM_ACTION_TIMEOUT_MS = String(ms);
  try {
    await run();
  } finally {
    if (original === undefined) delete process.env.SERVE_SIM_ACTION_TIMEOUT_MS;
    else process.env.SERVE_SIM_ACTION_TIMEOUT_MS = original;
  }
}

/** What a serving process records about itself; ownership is read from this, never from `ps`. */
export function recordState(udid: string, pid: number, port: number): () => void {
  mkdirSync(stateDir(), { recursive: true });
  const file = stateFileForDevice(udid);
  writeFileSync(
    file,
    JSON.stringify({
      pid,
      port,
      device: udid,
      url: `http://127.0.0.1:${port}`,
      streamUrl: `http://127.0.0.1:${port}/stream.mjpeg`,
      wsUrl: `ws://127.0.0.1:${port}/ws`,
    }),
  );
  return () => rmSync(file, { force: true });
}

/**
 * A throwaway state directory, so a record this test leaves behind can never name a live pid.
 *
 * Bun snapshots the environment at startup, so a child only sees the override when the caller
 * passes `{ ...process.env }` as its `env`; without that it reads the live directory.
 */
export function useTempStateDir(): { dir: string; restore(): void } {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-state-"));
  const original = process.env.SERVE_SIM_STATE_DIR;
  process.env.SERVE_SIM_STATE_DIR = dir;
  return {
    dir,
    restore() {
      if (original === undefined) delete process.env.SERVE_SIM_STATE_DIR;
      else process.env.SERVE_SIM_STATE_DIR = original;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** An OS-assigned port, so a test never names one a neighbouring run may already hold. */
export function freePortAsync(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * SIGKILL every serve-sim helper still streaming a device.
 *
 * `--kill <udid>` only reaches the pid in the state file, so a run that detached twice for one
 * device leaves the first helper behind. Several still attached to the same simulator starve the
 * capture subsystem, and the next server binds its port but never finishes initialising.
 *
 * Matched on whole argv tokens, and never against this process's own ancestors: a substring test
 * also selects the shell that launched the test run, because its command line carries the udid.
 */
export function killHelpersForDevice(udid: string): void {
  let listing = "";
  try {
    listing = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf-8" });
  } catch {
    return;
  }

  const parents = new Map<number, number>();
  const candidates = new Map<number, string[]>();
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, command] = match;
    parents.set(Number(pid), Number(ppid));
    candidates.set(Number(pid), command!.split(/\s+/));
  }

  const ancestors = new Set<number>();
  for (let pid = process.pid; pid > 1 && !ancestors.has(pid); pid = parents.get(pid) ?? 0) {
    ancestors.add(pid);
  }

  for (const [pid, tokens] of candidates) {
    if (ancestors.has(pid)) continue;
    if (!tokens.includes(udid) || !tokens.includes("--transport")) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

