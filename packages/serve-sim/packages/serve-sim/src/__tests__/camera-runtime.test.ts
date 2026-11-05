import { expect, test } from "bun:test";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

import { cameraHelperPidFile, cameraHelperSocketFile } from "../camera-helper";
import { stopExistingHelper } from "../camera-runtime";
import { hasProcessExited } from "../process-utils";
import { useTempStateDir } from "./helpers";

const udid = randomUUID().toUpperCase();

test("a helper that ignores SIGTERM is killed and its files are removed", async () => {
  const state = useTempStateDir();
  const helper = spawn("/bin/sh", ["-c", 'trap "" TERM; echo ready; while :; do sleep 0.1; done'], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    await new Promise((resolve) => helper.stdout!.once("data", resolve));
    mkdirSync(dirname(cameraHelperPidFile(udid)), { recursive: true });
    writeFileSync(cameraHelperPidFile(udid), String(helper.pid));
    writeFileSync(cameraHelperSocketFile(udid), "");
    stopExistingHelper(udid);
    expect(hasProcessExited(helper.pid!)).toBe(true);
    expect(existsSync(cameraHelperPidFile(udid))).toBe(false);
    expect(existsSync(cameraHelperSocketFile(udid))).toBe(false);
  } finally {
    helper.kill("SIGKILL");
    state.restore();
  }
}, 10_000);
