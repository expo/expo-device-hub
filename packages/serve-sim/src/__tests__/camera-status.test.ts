import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { createServer as createNetServer } from "net";
import { dirname } from "path";
import {
  cameraHelperBundlesFile,
  cameraHelperPidFile,
  cameraHelperSocketFile,
  isCameraHelperAlive,
  readCameraStatus,
} from "../camera-helper";
import { simMiddleware } from "../middleware";

const udid = randomUUID().toUpperCase();
const stateFiles = [
  cameraHelperPidFile(udid),
  cameraHelperBundlesFile(udid),
  cameraHelperSocketFile(udid),
];

beforeAll(() => {
  mkdirSync(dirname(cameraHelperPidFile(udid)), { recursive: true });
});

afterAll(() => {
  for (const path of stateFiles) {
    try { unlinkSync(path); } catch {}
  }
});

async function withMiddleware<T>(
  fn: (request: (path: string, init?: RequestInit) => Promise<Response>) => Promise<T>,
): Promise<T> {
  const middleware = simMiddleware({ basePath: "/", proxyHelpers: true });
  const request = async (path: string, init?: RequestInit) => {
    const response = await middleware(new Request(`http://localhost${path}`, init));
    if (!response) throw new Error(`Unhandled request: ${path}`);
    return response;
  };
  return fn(request);
}

describe("camera status", () => {
  test("treats a malformed pid file as a stopped helper", async () => {
    writeFileSync(cameraHelperPidFile(udid), "not-a-pid");

    expect(isCameraHelperAlive(udid)).toBe(false);
    expect(await readCameraStatus(udid)).toEqual({ udid, alive: false });
  });

  test("decodes split UTF-8, validates bundles, and keeps helper extensions", async () => {
    const socketPath = cameraHelperSocketFile(udid);
    try { unlinkSync(socketPath); } catch {}
    const reply = Buffer.from(JSON.stringify({
      ok: true,
      source: "video",
      arg: "/tmp/zażółć.mov",
      alive: false,
      udid: "wrong-device",
      helperPid: 0,
      bundleIds: ["wrong.bundle"],
      frameCount: 12,
    }) + "\n");
    const split = reply.indexOf(Buffer.from("ż")) + 1;
    const server = createNetServer((socket) => {
      socket.once("data", () => {
        socket.write(reply.subarray(0, split));
        socket.end(reply.subarray(split));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    writeFileSync(cameraHelperPidFile(udid), String(process.pid));
    writeFileSync(cameraHelperBundlesFile(udid), JSON.stringify({
      helperPid: process.pid,
      bundleIds: ["com.example.app", 42],
    }));

    try {
      expect(await readCameraStatus(udid)).toEqual({
        udid,
        alive: true,
        helperPid: process.pid,
        bundleIds: ["com.example.app"],
        ok: true,
        source: "video",
        arg: "/tmp/zażółć.mov",
        frameCount: 12,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("serves status without opening a simulator session", async () => {
    try { unlinkSync(cameraHelperPidFile(udid)); } catch {}
    await withMiddleware(async (request) => {
      const response = await request(`/helper/${udid}/camera/status`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ udid, alive: false });
    });
  });

  test("rejects writes and malformed device IDs", async () => {
    await withMiddleware(async (request) => {
      const writeResponse = await request(`/helper/${udid}/camera/status`, {
        method: "POST",
      });
      expect(writeResponse.status).toBe(405);
      expect(writeResponse.headers.get("allow")).toBe("GET");

      const invalidResponse = await request("/helper/not-a-udid/camera/status");
      expect(invalidResponse.status).toBe(400);
      expect(await invalidResponse.json()).toEqual({ error: "invalid_device" });
    });
  });
});
