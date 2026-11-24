import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServeSimStates } from "../middleware";
import { stateFileForDevice, writeServeSimState } from "../state";

test("a scoped discovery pass leaves another device's stale state alone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "single-device-state-"));
  const previous = process.env.SERVE_SIM_STATE_DIR;
  process.env.SERVE_SIM_STATE_DIR = directory;
  const other = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
  try {
    writeServeSimState({
      device: other,
      pid: 2147483647,
      port: 1,
      url: "http://localhost:1",
      streamUrl: "http://localhost:1/stream.mjpeg",
      wsUrl: "ws://localhost:1/ws",
    });
    expect(await readServeSimStates("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toEqual([]);
    expect(existsSync(stateFileForDevice(other))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.SERVE_SIM_STATE_DIR;
    else process.env.SERVE_SIM_STATE_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
