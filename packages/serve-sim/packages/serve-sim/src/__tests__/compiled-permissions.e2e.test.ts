import { describe, expect, test } from "bun:test";
import { linkSync, mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { freePortAsync } from "./helpers";

const PKG = join(import.meta.dir, "../..");
const BINARY = join(PKG, "dist/serve-sim");
const udid = e2eDevice();
const ready = Boolean(udid && existsSync(BINARY));
requireE2E("compiled permission dispatch", ready);

describe.skipIf(!ready)("compiled permission dispatch", () => {
  test("a renamed compiled server runs CLI-backed control actions through its real executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compiled-permission-"));
    const executable = join(PKG, `dist/permission-dispatch-${randomUUID()}`);
    linkSync(BINARY, executable);
    const port = await freePortAsync();
    const child = Bun.spawn([executable, udid!, "--port", String(port)], {
      env: { ...process.env, SERVE_SIM_STATE_DIR: dir },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const stateFile = join(dir, `server-${udid}.json`);
      const deadline = Date.now() + 60_000;
      while (!existsSync(stateFile) && Date.now() < deadline && child.exitCode === null)
        await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(stateFile)).toBe(true);
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      const reply = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/exec-ws`, [
            `serve-sim.token.${state.token}`,
          ]);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("compiled permissions reply timed out"));
          }, 30_000);
          ws.onmessage = (event) => {
            const value = JSON.parse(String(event.data));
            if (value.ready)
              ws.send(
                JSON.stringify({
                  id: 1,
                  action: "permissions.list",
                  params: { udid, bundleId: "dev.expo.permissions.compiled-read" },
                }),
              );
            if (value.id === 1) {
              clearTimeout(timeout);
              ws.close();
              resolve(value);
            }
          };
          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("compiled exec-ws failed"));
          };
        },
      );
      expect(reply.exitCode, reply.stderr).toBe(0);
      expect(JSON.parse(reply.stdout)).toMatchObject({
        udid,
        bundleId: "dev.expo.permissions.compiled-read",
        notifications: null,
      });
    } finally {
      child.kill("SIGTERM");
      await Promise.race([child.exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      rmSync(executable, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 100_000);
});
