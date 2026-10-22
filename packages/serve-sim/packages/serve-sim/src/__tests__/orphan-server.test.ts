import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adoptSession } from "../session-owner";
import { DEFAULT_STREAM_ENCODER_SETTINGS } from "../stream-settings";
import { useTempStateDir } from "./helpers";

const device = "00000000-0000-0000-0000-000000000288";
test.each([false, true])(
  "only explicit orphans offer adoption: orphan=%s",
  async (orphan) => {
    const state = useTempStateDir();
    const directory = state.dir;
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "fixtures/orphan-server.child.ts")],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SERVE_SIM_STATE_DIR: directory, ORPHAN_TEST: orphan ? "1" : "0" },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (data) => {
      stdout += data;
    });
    child.stderr!.on("data", (data) => {
      stderr += data;
    });
    const exited = once(child, "exit");
    try {
      for (let i = 0; i < 300 && !stdout.includes('"port"') && child.exitCode === null; i++)
        await Bun.sleep(10);
      expect(stdout, stderr).toContain('"port"');
      expect(existsSync(join(directory, `owner-${device}.json`))).toBe(orphan);
      const adopt = () =>
        adoptSession(
          device,
          JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")).version,
          "127.0.0.1",
          undefined,
          {
            stream: { transport: "webrtc", codec: "h264", ...DEFAULT_STREAM_ENCODER_SETTINGS },
            corsOrigins: [],
            frameAncestors: [],
            disableShare: false,
            networkCapture: false,
            networkCaptureFields: [],
          },
        );
      if (orphan) expect(await adopt()).toMatchObject({ device });
      await expect(adopt()).rejects.toThrow(
        `No adoptable serve-sim for ${device}: start it with --orphan, or it was already claimed.`,
      );
      child.kill("SIGTERM");
      expect(await exited).toEqual([0, null]);
      expect(existsSync(join(directory, `owner-${device}.json`))).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([exited, Bun.sleep(1000)]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      state.restore();
    }
  },
  8000,
);
