import { afterEach, describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { AppManagementError } from "../src/app-management.ts";
import type { StagedMultipartFile } from "../src/multipart-upload.ts";
import type { ScrcpySession } from "../src/scrcpy.ts";
import {
  startServer,
  type ServerDependencies,
  type ServerOpts,
  type StartedServer,
} from "../src/server.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

type CapturedServeOptions = {
  maxRequestBodySize?: number;
  fetch(
    request: Request,
    server: { upgrade(): boolean },
  ): Response | Promise<Response> | undefined;
  websocket?: { maxPayloadLength?: number };
};

type FakeSession = {
  session: ScrcpySession;
  readonly closeCalls: number;
};

type ServerHarness = {
  started: StartedServer;
  options: CapturedServeOptions;
  fetch(request: Request): Promise<Response>;
  serverStopCalls(): number;
};

const activeServers: StartedServer[] = [];

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeSession(serial: string, onClose?: () => void): FakeSession {
  const proc = new EventEmitter();
  const controlSocket = new EventEmitter() as EventEmitter & {
    write(data: Uint8Array): boolean;
  };
  controlSocket.write = () => true;
  let closeCalls = 0;
  let resolveFrame!: (frame: null) => void;
  const frame = new Promise<null>((resolve) => {
    resolveFrame = resolve;
  });
  const session = {
    transport: "scrcpy",
    meta: {
      deviceName: `device-${serial}`,
      codecId: "h264",
      width: 1080,
      height: 1920,
    },
    protocol: 3,
    videoReader: {},
    controlSocket,
    proc,
    scid: "00000001",
    localPort: 27_200,
    serial,
    readFrame: () => frame,
    close: () => {
      closeCalls++;
      resolveFrame(null);
      onClose?.();
    },
  } as unknown as ScrcpySession;
  return {
    session,
    get closeCalls() {
      return closeCalls;
    },
  };
}

async function createHarness(
  opts: Partial<ServerOpts> = {},
  dependencies: ServerDependencies = {},
): Promise<ServerHarness> {
  let captured: CapturedServeOptions | null = null;
  let stopCalls = 0;
  const initial = fakeSession(opts.serial ?? "device-old");
  const serve = ((options: CapturedServeOptions) => {
    captured = options;
    return {
      port: opts.port ?? 31_031,
      stop() {
        stopCalls++;
      },
    };
  }) as unknown as typeof Bun.serve;

  const started = await startServer(
    {
      serial: "device-old",
      port: 31_031,
      ...opts,
    },
    {
      startScrcpy: async () => initial.session,
      listAllDevices: async () => [
        { serial: "device-old", state: "device" },
        { serial: "device-new", state: "device" },
      ],
      serve,
      ...dependencies,
    },
  );
  activeServers.push(started);
  if (!captured) throw new Error("Bun.serve options were not captured");
  const options = captured as CapturedServeOptions;

  return {
    started,
    options,
    async fetch(request) {
      const response = await options.fetch(request, { upgrade: () => false });
      if (!(response instanceof Response)) {
        throw new Error("server fetch did not return a response");
      }
      return response;
    },
    serverStopCalls: () => stopCalls,
  };
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function streamedJsonRequest(
  chunks: string[],
  headers: HeadersInit = {},
): Request {
  const encoder = new TextEncoder();
  let index = 0;
  return new Request("http://localhost/api/devices/select", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
    }),
  });
}

function fakeUploadRequest(path: string, signal?: AbortSignal): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=fake" },
    body: "--fake--\r\n",
    signal,
  });
}

function stagedFile(
  name: string,
  cleanup: () => Promise<void> = async () => {},
): StagedMultipartFile {
  return {
    path: `/tmp/${name}`,
    filename: name,
    mediaType: "application/octet-stream",
    size: 4,
    cleanup,
  };
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not become true");
}

afterEach(async () => {
  const servers = activeServers.splice(0);
  await Promise.allSettled(servers.map((server) => server.stop()));
});

describe("server request and upload limits", () => {
  test.each([
    ["chunked", { "transfer-encoding": "chunked" }],
    ["missing Content-Length", {}],
    ["understated Content-Length", { "content-length": "1" }],
  ])("rejects %s oversized JSON with a structured 413", async (_, headers) => {
    const harness = await createHarness();
    const response = await harness.fetch(
      streamedJsonRequest(["{\"serial\":\"", "x".repeat(9_000), "\"}"], headers),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "payload-too-large",
    });
  });

  test("accepts ordinary APK and media multipart requests and removes staging files", async () => {
    const stagedPaths: string[] = [];
    const observed: Array<{
      kind: "apk" | "media";
      serial: string;
      filename: string;
      bytes: string;
    }> = [];
    const harness = await createHarness(
      { maxApkUploadBytes: 1_024, maxMediaUploadBytes: 2_048 },
      {
        installApk: async (serial, file) => {
          if (file instanceof File) throw new Error("expected staged APK");
          stagedPaths.push(file.path);
          observed.push({
            kind: "apk",
            serial,
            filename: file.filename,
            bytes: (await readFile(file.path)).toString(),
          });
          return { ok: true, output: "installed" };
        },
        importMediaFile: async (serial, file) => {
          if (file instanceof File) throw new Error("expected staged media");
          stagedPaths.push(file.path);
          observed.push({
            kind: "media",
            serial,
            filename: file.filename,
            bytes: (await readFile(file.path)).toString(),
          });
          return {
            ok: true,
            output: "imported",
            path: "/sdcard/Pictures/photo.jpg",
            kind: "image",
          };
        },
      },
    );

    const apk = new FormData();
    apk.set(
      "apk",
      new File(["apk-bytes"], "demo.apk", {
        type: "application/vnd.android.package-archive",
      }),
    );
    const media = new FormData();
    media.set("file", new File(["jpg-bytes"], "photo.jpg", { type: "image/jpeg" }));

    const installResponse = await harness.fetch(
      new Request("http://localhost/api/apps/install", {
        method: "POST",
        body: apk,
      }),
    );
    const importResponse = await harness.fetch(
      new Request("http://localhost/api/files/import", {
        method: "POST",
        body: media,
      }),
    );

    expect(installResponse.status).toBe(200);
    expect(importResponse.status).toBe(200);
    expect(observed).toEqual([
      {
        kind: "apk",
        serial: "device-old",
        filename: "demo.apk",
        bytes: "apk-bytes",
      },
      {
        kind: "media",
        serial: "device-old",
        filename: "photo.jpg",
        bytes: "jpg-bytes",
      },
    ]);
    for (const path of stagedPaths) {
      await expect(access(path)).rejects.toBeDefined();
    }
  });

  test("returns structured 413 responses for oversized APK and media files", async () => {
    let actionCalls = 0;
    const harness = await createHarness(
      { maxApkUploadBytes: 4, maxMediaUploadBytes: 5 },
      {
        installApk: async () => {
          actionCalls++;
          return { ok: true, output: "unexpected" };
        },
        importMediaFile: async () => {
          actionCalls++;
          return {
            ok: true,
            output: "unexpected",
            path: "/sdcard/unexpected",
            kind: "file",
          };
        },
      },
    );
    const apk = new FormData();
    apk.set("apk", new File(["12345"], "too-large.apk"));
    const media = new FormData();
    media.set("file", new File(["123456"], "too-large.bin"));

    const responses = await Promise.all([
      harness.fetch(
        new Request("http://localhost/api/apps/install", {
          method: "POST",
          body: apk,
        }),
      ),
      harness.fetch(
        new Request("http://localhost/api/files/import", {
          method: "POST",
          body: media,
        }),
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        ok: false,
        code: "payload-too-large",
      });
    }
    expect(actionCalls).toBe(0);
  });

  test("bounds active and queued uploads and rejects overflow before staging", async () => {
    const actions = [deferred<void>(), deferred<void>()];
    let actionCount = 0;
    let stageCalls = 0;
    let cleanupCalls = 0;
    const harness = await createHarness(
      { maxActiveUploads: 1, maxQueuedUploads: 1 },
      {
        stageMultipartUpload: async () => {
          stageCalls++;
          return stagedFile(`upload-${stageCalls}.apk`, async () => {
            cleanupCalls++;
          });
        },
        installApk: async () => {
          const action = actions[actionCount++]!;
          await action.promise;
          return { ok: true, output: "installed" };
        },
      },
    );

    const first = harness.fetch(fakeUploadRequest("/api/apps/install"));
    const second = harness.fetch(fakeUploadRequest("/api/apps/install"));
    const overflow = await harness.fetch(fakeUploadRequest("/api/apps/install"));

    expect(overflow.status).toBe(429);
    expect(await overflow.json()).toMatchObject({
      ok: false,
      code: "upload-queue-full",
    });
    expect(stageCalls).toBe(1);

    const health = await harness.fetch(new Request("http://localhost/health"));
    expect(await health.json()).toMatchObject({
      uploads: { active: 1, queued: 1 },
    });

    actions[0]!.resolve();
    expect((await first).status).toBe(200);
    await flushUntil(() => stageCalls === 2);
    actions[1]!.resolve();
    expect((await second).status).toBe(200);
    expect(cleanupCalls).toBe(2);
  });

  test("switching during staging cancels the old generation before closing it", async () => {
    const events: string[] = [];
    const old = fakeSession("device-old", () => events.push("old-close"));
    const next = fakeSession("device-new", () => events.push("new-close"));
    let stageStarted = false;
    let actionCalled = false;
    const harness = await createHarness({}, {
      startScrcpy: async ({ serial }) =>
        serial === "device-old" ? old.session : next.session,
      stageMultipartUpload: async (_request, options) => {
        stageStarted = true;
        return await new Promise<StagedMultipartFile>((_resolve, reject) => {
          const abort = () => {
            events.push("staging-cleanup");
            reject(options.signal?.reason);
          };
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) abort();
        });
      },
      installApk: async () => {
        actionCalled = true;
        return { ok: true, output: "unexpected" };
      },
    });

    const upload = harness.fetch(fakeUploadRequest("/api/apps/install"));
    await flushUntil(() => stageStarted);
    const switching = harness.fetch(
      jsonRequest("/api/devices/select", { serial: "device-new" }),
    );
    const [uploadResponse, switchResponse] = await Promise.all([upload, switching]);

    expect(uploadResponse.status).toBe(409);
    expect(await uploadResponse.json()).toMatchObject({
      code: "device-session-changed",
    });
    expect(switchResponse.status).toBe(200);
    expect(actionCalled).toBe(false);
    expect(events.slice(0, 2)).toEqual(["staging-cleanup", "old-close"]);
  });

  test("switching during ADB keeps the captured old serial and waits for cleanup", async () => {
    const events: string[] = [];
    const cleanupGate = deferred<void>();
    const old = fakeSession("device-old", () => events.push("old-close"));
    const next = fakeSession("device-new");
    let adbStarted = false;
    let actionSerial = "";
    const harness = await createHarness({}, {
      startScrcpy: async ({ serial }) =>
        serial === "device-old" ? old.session : next.session,
      stageMultipartUpload: async () =>
        stagedFile("switch.apk", async () => {
          events.push("cleanup-start");
          await cleanupGate.promise;
          events.push("cleanup-done");
        }),
      installApk: async (serial, _file, signal) => {
        actionSerial = serial;
        adbStarted = true;
        return await new Promise((_resolve, reject) => {
          const abort = () => {
            events.push("adb-abort");
            reject(signal?.reason);
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      },
    });

    const upload = harness.fetch(fakeUploadRequest("/api/apps/install"));
    await flushUntil(() => adbStarted);
    let switchSettled = false;
    const switching = harness
      .fetch(jsonRequest("/api/devices/select", { serial: "device-new" }))
      .finally(() => {
        switchSettled = true;
      });
    await flushUntil(() => events.includes("cleanup-start"));

    expect(actionSerial).toBe("device-old");
    expect(switchSettled).toBe(false);
    expect(old.closeCalls).toBe(0);

    cleanupGate.resolve();
    const [uploadResponse, switchResponse] = await Promise.all([upload, switching]);
    expect(uploadResponse.status).toBe(409);
    expect(switchResponse.status).toBe(200);
    expect(events).toEqual([
      "adb-abort",
      "cleanup-start",
      "cleanup-done",
      "old-close",
    ]);
  });

  test("request abort cancels active work and cleans its staged file", async () => {
    const controller = new AbortController();
    let actionStarted = false;
    let cleanupCalls = 0;
    const harness = await createHarness({}, {
      stageMultipartUpload: async () =>
        stagedFile("aborted.apk", async () => {
          cleanupCalls++;
        }),
      installApk: async (_serial, _file, signal) => {
        actionStarted = true;
        return await new Promise((_resolve, reject) => {
          const abort = () => reject(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      },
    });

    const upload = harness.fetch(
      fakeUploadRequest("/api/apps/install", controller.signal),
    );
    await flushUntil(() => actionStarted);
    controller.abort(new Error("client disconnected"));
    const response = await upload;

    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "upload-cancelled",
    });
    expect(cleanupCalls).toBe(1);
  });

  test("reports a staging cleanup failure even when the request is cancelled", async () => {
    const controller = new AbortController();
    let actionStarted = false;
    const harness = await createHarness({}, {
      stageMultipartUpload: async () =>
        stagedFile("cleanup-failure.apk", async () => {
          throw new Error("temporary directory is still present");
        }),
      installApk: async (_serial, _file, signal) => {
        actionStarted = true;
        return await new Promise((_resolve, reject) => {
          const abort = () => reject(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      },
    });

    const upload = harness.fetch(
      fakeUploadRequest("/api/apps/install", controller.signal),
    );
    await flushUntil(() => actionStarted);
    controller.abort(new Error("client disconnected"));
    const response = await upload;

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "upload-cleanup-failed",
    });
  });

  test("reports a remote partial cleanup failure after cancellation", async () => {
    const controller = new AbortController();
    let actionStarted = false;
    const harness = await createHarness({}, {
      stageMultipartUpload: async () => stagedFile("cleanup-failure.jpg"),
      importMediaFile: async (_serial, _file, signal) => {
        actionStarted = true;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else
            signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        throw new AppManagementError(
          "adb-cleanup-failed",
          "failed to remove remote partial upload",
        );
      },
    });

    const upload = harness.fetch(
      fakeUploadRequest("/api/files/import", controller.signal),
    );
    await flushUntil(() => actionStarted);
    controller.abort(new Error("client disconnected"));
    const response = await upload;

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "adb-cleanup-failed",
    });
  });

  test("maps ADB failure and timeout errors and still cleans staging", async () => {
    let action = 0;
    let cleanupCalls = 0;
    const harness = await createHarness({}, {
      stageMultipartUpload: async () =>
        stagedFile("error.apk", async () => {
          cleanupCalls++;
        }),
      installApk: async () => {
        action++;
        throw new AppManagementError(
          action === 1 ? "adb-failed" : "adb-timeout",
          action === 1 ? "adb install failed" : "adb install timed out",
        );
      },
    });

    const failed = await harness.fetch(fakeUploadRequest("/api/apps/install"));
    const timedOut = await harness.fetch(fakeUploadRequest("/api/apps/install"));

    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: "adb-failed" });
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toMatchObject({ code: "adb-timeout" });
    expect(cleanupCalls).toBe(2);
  });

  test("async stop waits for active upload cleanup", async () => {
    const cleanupGate = deferred<void>();
    let actionStarted = false;
    let cleanupStarted = false;
    const harness = await createHarness({}, {
      stageMultipartUpload: async () =>
        stagedFile("stop.apk", async () => {
          cleanupStarted = true;
          await cleanupGate.promise;
        }),
      installApk: async (_serial, _file, signal) => {
        actionStarted = true;
        return await new Promise((_resolve, reject) => {
          const abort = () => reject(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      },
    });

    const upload = harness.fetch(fakeUploadRequest("/api/apps/install"));
    await flushUntil(() => actionStarted);
    let stopSettled = false;
    const stopping = harness.started.stop().finally(() => {
      stopSettled = true;
    });
    await flushUntil(() => cleanupStarted);

    expect(harness.serverStopCalls()).toBe(1);
    expect(stopSettled).toBe(false);
    cleanupGate.resolve();
    await stopping;
    expect(stopSettled).toBe(true);

    const response = await upload;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "device-session-changed",
    });
  });

  test("passes HTTP and WebSocket byte ceilings to Bun.serve", async () => {
    const harness = await createHarness({
      maxApkUploadBytes: 123,
      maxMediaUploadBytes: 456,
    });

    expect(harness.options.maxRequestBodySize).toBe(
      456 + 2 * 1024 * 1024,
    );
    expect(harness.options.websocket?.maxPayloadLength).toBe(16 * 1024);
  });

  test("rejects upload limits that would overflow Bun's body ceiling", async () => {
    const unsafeUploadLimit =
      Number.MAX_SAFE_INTEGER - 2 * 1024 * 1024 + 1;

    await expect(
      startServer({
        serial: "device-old",
        maxMediaUploadBytes: unsafeUploadLimit,
      }),
    ).rejects.toThrow("upload byte limit is too large");
  });

  test("rejects queue timeouts above the platform timer range", async () => {
    await expect(
      startServer({
        serial: "device-old",
        uploadQueueTimeoutMs: 2_147_483_648,
      }),
    ).rejects.toThrow("uploadQueueTimeoutMs must be at most 2147483647");
  });
});
