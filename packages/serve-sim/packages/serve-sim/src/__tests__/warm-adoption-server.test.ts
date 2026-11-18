import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adoptSession } from "../session-owner";
import { DEFAULT_STREAM_ENCODER_SETTINGS } from "../stream-settings";
import { useTempStateDir } from "./helpers";

const first = "00000000-0000-0000-0000-000000000501";
const extra = "00000000-0000-0000-0000-000000000502";

test.each([
  { failure: "none", log: `released ${extra}`, exitCode: 0 },
  { failure: "warmup", log: "Warm Simulator cleanup failed", exitCode: 1 },
  { failure: "retire", log: `Could not shut down Simulator ${extra}`, exitCode: 1 },
  { failure: "warmup-during", log: "Warm Simulator cleanup failed", exitCode: 1 },
  { failure: "foreign", log: "", exitCode: 0 },
  { failure: "cancel-reservation", log: "", exitCode: 0 },
])(
  "adopting the first warm device keeps it after a failure on the extra device: $failure",
  async ({ failure, log, exitCode }) => {
    const state = useTempStateDir();
    const foreign = JSON.stringify({ pid: process.pid, device: extra });
    if (failure === "foreign") writeFileSync(join(state.dir, `server-${extra}.json`), foreign);
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "fixtures/warm-adoption-server.child.ts")],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SERVE_SIM_STATE_DIR: state.dir, WARM_FAILURE: failure },
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
    const waitFor = async (text: () => boolean) => {
      for (let i = 0; i < 300 && !text() && child.exitCode === null; i++) await Bun.sleep(10);
      expect(text(), stderr).toBe(true);
    };
    try {
      await waitFor(() => stdout.includes('"port"'));
      if (failure.startsWith("warmup"))
        await waitFor(() => stderr.includes(`warmup waiting ${extra}`));
      const adoption = adoptSession(
        first,
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
      if (failure === "warmup-during") {
        // A cleanup failure during adoption fails it, so the job starts cold.
        await expect(adoption).rejects.toThrow("session_configuration_failed");
      } else {
        expect(await adoption).toMatchObject({ device: first });
      }
      if (failure === "cancel-reservation") {
        writeFileSync(join(state.dir, "release-extra-lock"), "");
        await waitFor(() => stderr.includes("reservation lock released"));
      }
      await waitFor(() => stderr.includes(log));
      // The server keeps running after the failure until its stop.
      await Bun.sleep(200);
      if (failure === "foreign") {
        expect(readFileSync(join(state.dir, `server-${extra}.json`), "utf8")).toBe(foreign);
        expect(stderr).not.toContain(`native ${extra}`);
        expect(stderr).not.toContain(`released ${extra}`);
      }
      if (failure === "cancel-reservation") {
        expect(existsSync(join(state.dir, `launch-${extra}.json`))).toBe(false);
        expect(stderr).not.toContain(`native ${extra}`);
        expect(stderr).not.toContain(`released ${extra}`);
      }
      expect(child.exitCode).toBeNull();
      child.kill("SIGTERM");
      expect((await exited)[0], stderr).toBe(exitCode);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      state.restore();
    }
  },
  10000,
);
