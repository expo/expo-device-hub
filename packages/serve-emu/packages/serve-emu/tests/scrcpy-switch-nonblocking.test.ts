import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import type { ChildProcess } from "node:child_process";
import { startServer } from "../src/server.ts";
import {
  FramedReader,
  type ScrcpySession,
  type StartOpts,
} from "../src/scrcpy.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeSession(
  serial: string,
  onClose: () => void = () => {},
): ScrcpySession {
  const videoSocket = new Socket();
  const controlSocket = new Socket();
  const frame = deferred<null>();
  const proc = new EventEmitter() as EventEmitter & {
    kill: () => boolean;
  };
  proc.kill = () => true;
  let closeTask: Promise<void> | null = null;

  return {
    transport: "scrcpy",
    meta: {
      deviceName: serial,
      codecId: "h264",
      width: 1080,
      height: 1920,
    },
    protocol: 3,
    videoReader: new FramedReader(videoSocket),
    controlSocket,
    proc: proc as unknown as ChildProcess,
    scid: "00000001",
    localPort: 27200,
    serial,
    readFrame: () => frame.promise,
    close: () => {
      if (closeTask) return closeTask;
      closeTask = Promise.resolve().then(() => {
        onClose();
        frame.resolve(null);
        videoSocket.destroy();
        controlSocket.destroy();
      });
      return closeTask;
    },
  };
}

describe("live device switching", () => {
  test("keeps timers and HTTP responsive while the next scrcpy session waits", async () => {
    const initial = fakeSession("device-1");
    const next = fakeSession("device-2");
    const nextStart = deferred<ScrcpySession>();
    const nextRequested = deferred<void>();

    const started = await startServer(
      { serial: "device-1", host: "127.0.0.1", port: 0 },
      {
        listAllDevices: async () => [
          { serial: "device-1", state: "device" },
          { serial: "device-2", state: "device" },
        ],
        startScrcpy: async (opts: StartOpts) => {
          if (opts.serial === "device-1") return initial;
          nextRequested.resolve();
          return nextStart.promise;
        },
      },
    );

    try {
      const baseUrl = `http://127.0.0.1:${started.server.port}`;
      const switching = fetch(`${baseUrl}/api/devices/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serial: "device-2" }),
      });
      await nextRequested.promise;

      let timerAdvanced = false;
      setTimeout(() => {
        timerAdvanced = true;
      }, 5);
      await Bun.sleep(20);

      const healthResponse = await Promise.race([
        fetch(`${baseUrl}/health`),
        Bun.sleep(500).then(() => {
          throw new Error("health request stalled during device switch");
        }),
      ]);
      const health = (await healthResponse.json()) as {
        status: string;
        serial: string;
      };
      expect(timerAdvanced).toBe(true);
      expect(healthResponse.status).toBe(200);
      expect(health).toMatchObject({
        status: "streaming",
        serial: "device-1",
      });

      nextStart.resolve(next);
      const switchResponse = await switching;
      expect(switchResponse.status).toBe(200);
      expect(await switchResponse.json()).toMatchObject({
        ok: true,
        serial: "device-2",
      });
    } finally {
      nextStart.resolve(next);
      await started.stop();
    }
  });

  test("server stop aborts and awaits a pending session switch", async () => {
    let initialCloseCount = 0;
    let candidateCloseCount = 0;
    const initial = fakeSession("device-1", () => initialCloseCount++);
    const candidate = fakeSession("device-2", () => candidateCloseCount++);
    const candidateStart = deferred<ScrcpySession>();
    const candidateRequested = deferred<AbortSignal>();

    const started = await startServer(
      { serial: "device-1", host: "127.0.0.1", port: 0 },
      {
        listAllDevices: async () => [
          { serial: "device-1", state: "device" },
          { serial: "device-2", state: "device" },
        ],
        startScrcpy: async (opts: StartOpts) => {
          if (opts.serial === "device-1") return initial;
          candidateRequested.resolve(opts.signal!);
          return candidateStart.promise;
        },
      },
    );

    const baseUrl = `http://127.0.0.1:${started.server.port}`;
    const switching = fetch(`${baseUrl}/api/devices/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serial: "device-2" }),
    }).catch((error) => error);
    const switchSignal = await candidateRequested.promise;

    let stopSettled = false;
    const stopping = started.stop().then(() => {
      stopSettled = true;
    });
    expect(switchSignal.aborted).toBe(true);
    await Bun.sleep(10);
    expect(stopSettled).toBe(false);

    candidateStart.resolve(candidate);
    await stopping;
    await switching;
    expect(initialCloseCount).toBe(1);
    expect(candidateCloseCount).toBe(1);
  });

  test("closes the initial session when the HTTP port cannot bind", async () => {
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("occupied"),
    });
    let closeCount = 0;
    const initial = fakeSession("device-1", () => closeCount++);

    try {
      await expect(
        startServer(
          {
            serial: "device-1",
            host: "127.0.0.1",
            port: occupied.port,
          },
          { startScrcpy: async () => initial },
        ),
      ).rejects.toThrow();
      expect(closeCount).toBe(1);
    } finally {
      occupied.stop(true);
    }
  });
});
