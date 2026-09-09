import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMiddlewareUploader } from "../src/middleware-upload.ts";
import { stageMultipartUpload } from "../src/multipart-upload.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not settle");
}

function multipartBody(
  boundary: string,
  fieldName: string,
  filename: string,
  data: string,
): Uint8Array {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n",
    ),
    Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

function multipartRequest(
  body: Uint8Array,
  boundary: string,
  options: {
    contentLength?: string;
    onCancel?: (reason: unknown) => void;
  } = {},
): Request {
  let offset = 0;
  const headers = new Headers({
    "content-type": `multipart/form-data; boundary=${boundary}`,
  });
  if (options.contentLength !== undefined) {
    headers.set("content-length", options.contentLength);
  }
  return new Request("http://localhost/api/apps/install", {
    method: "POST",
    headers,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(body.byteLength, offset + 2);
        controller.enqueue(body.slice(offset, end));
        offset = end;
      },
      cancel(reason) {
        options.onCancel?.(reason);
      },
    }),
  });
}

function ignoredUploadRequest(
  signal?: AbortSignal,
  onCancel?: (reason: unknown) => void,
): Request {
  return new Request("http://localhost/api/apps/install", {
    method: "POST",
    signal,
    body: new ReadableStream<Uint8Array>({
      cancel(reason) {
        onCancel?.(reason);
      },
    }),
  });
}

describe("middleware uploads", () => {
  test("streams a Fetch request without Content-Length and removes the staged file", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "serve-emu-middleware-upload-test-"),
    );
    let stagedPath = "";
    let observedBytes = "";
    const uploader = createMiddlewareUploader(
      {
        serial: "device-a",
        maxApkUploadBytes: 1_024,
        maxMediaUploadBytes: 1_024,
      },
      {
        stageMultipartUpload: (request, options) =>
          stageMultipartUpload(request, { ...options, tempRoot }),
        installApk: async (serial, file) => {
          expect(serial).toBe("device-a");
          stagedPath = file.path;
          observedBytes = await readFile(file.path, "utf8");
          return { ok: true, output: "installed" };
        },
      },
    );

    try {
      const boundary = "middleware-success";
      const response = await uploader.install(
        multipartRequest(
          multipartBody(boundary, "apk", "demo.apk", "apk-bytes"),
          boundary,
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        output: "installed",
      });
      expect(observedBytes).toBe("apk-bytes");
      await expect(access(stagedPath)).rejects.toBeDefined();
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await uploader.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ["missing Content-Length", undefined],
    ["understated Content-Length", "1"],
  ])("rejects oversized actual bytes with %s", async (_label, contentLength) => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "serve-emu-middleware-upload-limit-test-"),
    );
    let actionCalls = 0;
    const uploader = createMiddlewareUploader(
      {
        serial: "device-a",
        maxApkUploadBytes: 4,
        maxMediaUploadBytes: 4,
      },
      {
        stageMultipartUpload: (request, options) =>
          stageMultipartUpload(request, { ...options, tempRoot }),
        installApk: async () => {
          actionCalls++;
          return { ok: true, output: "unexpected" };
        },
      },
    );

    try {
      const boundary = "middleware-too-large";
      const response = await uploader.install(
        multipartRequest(
          multipartBody(boundary, "apk", "large.apk", "12345"),
          boundary,
          { contentLength },
        ),
      );

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        ok: false,
        code: "payload-too-large",
      });
      expect(actionCalls).toBe(0);
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      await uploader.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("bounds active and queued work and cancels overflow request bodies", async () => {
    const actionGates = [deferred(), deferred()];
    let actionCalls = 0;
    let stageCalls = 0;
    let cleanupCalls = 0;
    let overflowCancelled = false;
    const uploader = createMiddlewareUploader(
      {
        serial: "device-a",
        maxApkUploadBytes: 32,
        maxMediaUploadBytes: 32,
        maxActiveUploads: 1,
        maxQueuedUploads: 1,
        uploadQueueTimeoutMs: 10_000,
      },
      {
        stageMultipartUpload: async () => {
          stageCalls++;
          return {
            path: `/tmp/upload-${stageCalls}.apk`,
            filename: `upload-${stageCalls}.apk`,
            mediaType: "application/vnd.android.package-archive",
            size: 1,
            cleanup: async () => {
              cleanupCalls++;
            },
          };
        },
        installApk: async () => {
          const gate = actionGates[actionCalls++]!;
          await gate.promise;
          return { ok: true, output: "installed" };
        },
      },
    );

    try {
      const first = uploader.install(ignoredUploadRequest());
      await flushUntil(() => actionCalls === 1);
      const second = uploader.install(ignoredUploadRequest());
      const overflow = await uploader.install(
        ignoredUploadRequest(undefined, () => {
          overflowCancelled = true;
        }),
      );

      expect(overflow.status).toBe(429);
      expect(await overflow.json()).toMatchObject({
        ok: false,
        code: "upload-queue-full",
      });
      expect(stageCalls).toBe(1);
      expect(overflowCancelled).toBe(true);
      expect(uploader.snapshot()).toMatchObject({ active: 1, queued: 1 });

      actionGates[0]!.resolve();
      expect((await first).status).toBe(200);
      await flushUntil(() => actionCalls === 2);
      actionGates[1]!.resolve();
      expect((await second).status).toBe(200);
      expect(cleanupCalls).toBe(2);
    } finally {
      await uploader.close();
    }
  });

  test("request cancellation aborts ADB work and waits for cleanup", async () => {
    const controller = new AbortController();
    let actionStarted = false;
    let actionAborted = false;
    let cleanupCalls = 0;
    const uploader = createMiddlewareUploader(
      {
        serial: "device-a",
        maxApkUploadBytes: 32,
        maxMediaUploadBytes: 32,
      },
      {
        stageMultipartUpload: async () => ({
          path: "/tmp/cancelled.apk",
          filename: "cancelled.apk",
          mediaType: "application/vnd.android.package-archive",
          size: 1,
          cleanup: async () => {
            cleanupCalls++;
          },
        }),
        installApk: async (_serial, _file, signal) => {
          actionStarted = true;
          return await new Promise((_resolve, reject) => {
            const abort = () => {
              actionAborted = true;
              reject(signal?.reason);
            };
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        },
      },
    );

    try {
      const responsePromise = uploader.install(
        ignoredUploadRequest(controller.signal),
      );
      await flushUntil(() => actionStarted);
      controller.abort(new Error("client disconnected"));
      const response = await responsePromise;

      expect(response.status).toBe(499);
      expect(await response.json()).toMatchObject({
        ok: false,
        code: "upload-cancelled",
      });
      expect(actionAborted).toBe(true);
      expect(cleanupCalls).toBe(1);
      expect(uploader.snapshot()).toMatchObject({ active: 0, queued: 0 });
    } finally {
      await uploader.close();
    }
  });
});
