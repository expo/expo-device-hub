import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  MultipartUploadError,
  stageMultipartUpload,
  type StageMultipartUploadOptions,
} from "../src/multipart-upload.ts";
import {
  HttpBodyError,
  MAX_REQUEST_BODY_CHUNKS,
} from "../src/request-body.ts";

const encoder = new TextEncoder();

type MultipartPart = {
  name: string;
  filename?: string;
  mediaType?: string;
  data: string | Uint8Array;
};

function multipartBody(boundary: string, parts: MultipartPart[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const disposition =
      `Content-Disposition: form-data; name="${part.name}"` +
      (part.filename === undefined ? "" : `; filename="${part.filename}"`);
    const headers = [disposition];
    if (part.mediaType) headers.push(`Content-Type: ${part.mediaType}`);
    chunks.push(
      encoder.encode(`--${boundary}\r\n${headers.join("\r\n")}\r\n\r\n`),
      typeof part.data === "string" ? encoder.encode(part.data) : part.data,
      encoder.encode("\r\n"),
    );
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function splitEvery(body: Uint8Array, bytes: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < body.byteLength; offset += bytes) {
    chunks.push(body.slice(offset, offset + bytes));
  }
  return chunks;
}

function multipartRequest(
  boundary: string,
  chunks: Uint8Array[],
  options: {
    contentLength?: string;
    onPull?: () => void;
    onCancel?: (reason: unknown) => void;
  } = {},
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      options.onPull?.();
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel(reason) {
      options.onCancel?.(reason);
    },
  });
  const headers = new Headers({
    "content-type": `multipart/form-data; boundary=${boundary}`,
  });
  if (options.contentLength !== undefined) {
    headers.set("content-length", options.contentLength);
  }
  return new Request("http://localhost/upload", {
    method: "POST",
    headers,
    body,
  });
}

function byteFragmentedMultipartRequest(
  boundary: string,
  body: Uint8Array,
  onCancel?: (reason: unknown) => void,
): Request {
  let offset = 0;
  return new Request("http://localhost/upload", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === body.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(body.subarray(offset, ++offset));
      },
      cancel(reason) {
        onCancel?.(reason);
      },
    }),
  });
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "serve-emu-multipart-test-"));
}

async function expectNoUploads(root: string): Promise<void> {
  expect(await readdir(root)).toEqual([]);
}

function baseOptions(
  root: string,
  bodyBytes: number,
  fileBytes: number,
): StageMultipartUploadOptions {
  return {
    fieldName: "apk",
    maxBodyBytes: bodyBytes,
    maxFileBytes: fileBytes,
    tempRoot: root,
  };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}

describe("stageMultipartUpload", () => {
  test("streams a fragmented file at the exact body and file limits", async () => {
    const root = await tempRoot();
    try {
      const boundary = "exact-boundary";
      const file = encoder.encode("APK!");
      const body = multipartBody(boundary, [
        {
          name: "apk",
          filename: "demo.apk",
          mediaType: "application/vnd.android.package-archive",
          data: file,
        },
      ]);
      const staged = await stageMultipartUpload(
        multipartRequest(boundary, splitEvery(body, 1), {
          contentLength: String(body.byteLength),
        }),
        baseOptions(root, body.byteLength, file.byteLength),
      );

      expect(staged.filename).toBe("demo.apk");
      expect(staged.path.endsWith("/upload.apk")).toBe(true);
      expect(staged.mediaType).toBe(
        "application/vnd.android.package-archive",
      );
      expect(staged.size).toBe(file.byteLength);
      expect(await readFile(staged.path)).toEqual(Buffer.from(file));

      const firstCleanup = staged.cleanup();
      expect(staged.cleanup()).toBe(firstCleanup);
      await Promise.all([firstCleanup, staged.cleanup()]);
      await expectNoUploads(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(
    "handles a 200 KiB upload fragmented into one-byte chunks while timers advance",
    async () => {
      const root = await tempRoot();
      try {
        const boundary = "adversarial-fragmentation";
        const file = new Uint8Array(200 * 1024).fill(0x5a);
        const body = multipartBody(boundary, [
          { name: "apk", filename: "fragmented.apk", data: file },
        ]);
        let completed = false;
        let timerRanDuringUpload = false;
        const progressTimer = setTimeout(() => {
          timerRanDuringUpload = !completed;
        }, 0);
        const staged = await stageMultipartUpload(
          byteFragmentedMultipartRequest(boundary, body),
          baseOptions(root, body.byteLength, file.byteLength),
        );
        completed = true;
        clearTimeout(progressTimer);

        expect(staged.size).toBe(file.byteLength);
        expect(timerRanDuringUpload).toBe(true);
        await staged.cleanup();
        await expectNoUploads(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    2_000,
  );

  test(
    "rejects and cleans up multipart bodies above the stream chunk limit",
    async () => {
      const root = await tempRoot();
      try {
        const boundary = "chunk-count-limit";
        const file = new Uint8Array(MAX_REQUEST_BODY_CHUNKS).fill(0x61);
        const body = multipartBody(boundary, [
          { name: "apk", filename: "fragmented.apk", data: file },
        ]);
        const cancellations: unknown[] = [];
        const error = await captureError(
          stageMultipartUpload(
            byteFragmentedMultipartRequest(
              boundary,
              body,
              (reason) => cancellations.push(reason),
            ),
            baseOptions(root, body.byteLength, file.byteLength),
          ),
        );

        expect(error).toBeInstanceOf(HttpBodyError);
        expect((error as HttpBodyError).code).toBe("too-many-body-chunks");
        expect((error as HttpBodyError).status).toBe(413);
        expect(cancellations).toHaveLength(1);
        await expectNoUploads(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    3_000,
  );

  test("preserves nonuniform file bytes when the parser ring wraps", async () => {
    const root = await tempRoot();
    try {
      for (const fileBytes of [
        8_191,
        8_192,
        8_193,
        65_535,
        65_536,
        65_537,
        73_727,
        73_728,
        73_729,
      ]) {
        const boundary = "boundary-0123456789";
        const file = Uint8Array.from(
          { length: fileBytes },
          (_, index) => index % 251,
        );
        const body = multipartBody(boundary, [
          { name: "apk", filename: `${fileBytes}.apk`, data: file },
        ]);
        const staged = await stageMultipartUpload(
          multipartRequest(boundary, [body]),
          baseOptions(root, body.byteLength, file.byteLength),
        );

        expect(await readFile(staged.path)).toEqual(Buffer.from(file));
        await staged.cleanup();
        await expectNoUploads(root);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects one byte beyond the actual file limit and removes partial data", async () => {
    const root = await tempRoot();
    try {
      const boundary = "file-limit";
      const file = encoder.encode("12345");
      const body = multipartBody(boundary, [
        { name: "apk", filename: "large.apk", data: file },
      ]);
      const error = await captureError(
        stageMultipartUpload(
          multipartRequest(boundary, splitEvery(body, 2)),
          baseOptions(root, body.byteLength, file.byteLength - 1),
        ),
      );

      expect(error).toBeInstanceOf(HttpBodyError);
      expect((error as HttpBodyError).code).toBe("payload-too-large");
      expect((error as HttpBodyError).status).toBe(413);
      expect((error as HttpBodyError).limit).toBe(4);
      await expectNoUploads(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("counts streamed body bytes even when Content-Length is understated", async () => {
    const root = await tempRoot();
    try {
      const boundary = "body-limit";
      const body = multipartBody(boundary, [
        { name: "apk", filename: "demo.apk", data: "ok" },
      ]);
      const error = await captureError(
        stageMultipartUpload(
          multipartRequest(boundary, splitEvery(body, 3), {
            contentLength: "1",
          }),
          baseOptions(root, body.byteLength - 1, 2),
        ),
      );

      expect(error).toBeInstanceOf(HttpBodyError);
      expect((error as HttpBodyError).code).toBe("payload-too-large");
      expect((error as HttpBodyError).received).toBe(body.byteLength);
      await expectNoUploads(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "wrong file field",
      parts: [{ name: "file", filename: "demo.apk", data: "one" }],
    },
    {
      name: "duplicate file field",
      parts: [
        { name: "apk", filename: "one.apk", data: "one" },
        { name: "apk", filename: "two.apk", data: "two" },
      ],
    },
    {
      name: "extra text part",
      parts: [
        { name: "apk", filename: "one.apk", data: "one" },
        { name: "note", data: "extra" },
      ],
    },
    {
      name: "non-file expected field",
      parts: [{ name: "apk", data: "not a file" }],
    },
  ])("rejects $name and removes its staging directory", async ({ parts }) => {
    const root = await tempRoot();
    try {
      const boundary = "part-shape";
      const body = multipartBody(boundary, parts);
      const error = await captureError(
        stageMultipartUpload(
          multipartRequest(boundary, splitEvery(body, 5)),
          baseOptions(root, body.byteLength, body.byteLength),
        ),
      );

      expect(error).toBeInstanceOf(MultipartUploadError);
      expect((error as MultipartUploadError).code).toBe(
        "unexpected-multipart-part",
      );
      await expectNoUploads(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed multipart input and bounded-out headers", async () => {
    for (const body of [
      encoder.encode("--broken\r\nContent-Disposition: form-data"),
      encoder.encode(
        "--headers\r\nX-One: 1\r\nX-Two: 2\r\n" +
          'Content-Disposition: form-data; name="apk"; filename="a.apk"\r\n' +
          "\r\ndata\r\n--headers--\r\n",
      ),
    ]) {
      const root = await tempRoot();
      try {
        const boundary = body[2] === 104 ? "headers" : "broken";
        const error = await captureError(
          stageMultipartUpload(
            multipartRequest(boundary, splitEvery(body, 2)),
            {
              ...baseOptions(root, body.byteLength, body.byteLength),
              maxHeaderPairs: 2,
              maxHeaderBytes: 128,
            },
          ),
        );
        expect(error).toBeInstanceOf(MultipartUploadError);
        await expectNoUploads(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("aborts a pending upload and removes the partial file", async () => {
    const root = await tempRoot();
    try {
      const controller = new AbortController();
      const reason = new Error("client disconnected");
      const boundary = "abort-boundary";
      const prefix = encoder.encode(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="apk"; filename="a.apk"\r\n' +
          "Content-Type: application/octet-stream\r\n\r\npartial",
      );
      let cancelled = false;
      const request = new Request("http://localhost/upload", {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body: new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(prefix);
          },
          cancel() {
            cancelled = true;
          },
        }),
      });
      const staging = stageMultipartUpload(request, {
        ...baseOptions(root, 1024, 512),
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort(reason);
      const error = await captureError(staging);

      expect(error).toBeInstanceOf(HttpBodyError);
      expect((error as HttpBodyError).code).toBe("request-aborted");
      expect(error).toHaveProperty("cause", reason);
      expect(cancelled).toBe(true);
      await expectNoUploads(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports an asynchronous writer failure and removes the partial file", async () => {
    const root = await tempRoot();
    try {
      const boundary = "write-failure";
      const body = multipartBody(boundary, [
        { name: "apk", filename: "a.apk", data: "content" },
      ]);
      const diskError = new Error("disk full");
      const error = await captureError(
        stageMultipartUpload(
          multipartRequest(boundary, splitEvery(body, 2)),
          {
            ...baseOptions(root, body.byteLength, 7),
            writerFactory: () =>
              new Writable({
                write(_chunk, _encoding, callback) {
                  queueMicrotask(() => callback(diskError));
                },
              }),
          },
        ),
      );

      expect(error).toBeInstanceOf(MultipartUploadError);
      expect((error as MultipartUploadError).code).toBe(
        "upload-write-failed",
      );
      await expectNoUploads(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("classifies temporary-directory creation failures as server errors", async () => {
    const root = await tempRoot();
    try {
      const boundary = "missing-temp-root";
      const body = multipartBody(boundary, [
        { name: "apk", filename: "demo.apk", data: "apk" },
      ]);
      const error = await captureError(
        stageMultipartUpload(
          multipartRequest(boundary, [body]),
          {
            ...baseOptions(root, body.byteLength, 3),
            tempRoot: join(root, "missing"),
          },
        ),
      );

      expect(error).toBeInstanceOf(MultipartUploadError);
      expect((error as MultipartUploadError).code).toBe(
        "upload-write-failed",
      );
      expect((error as MultipartUploadError).status).toBe(500);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stops pulling request chunks while the file destination is backpressured", async () => {
    const root = await tempRoot();
    try {
      const boundary = "backpressure";
      const file = new Uint8Array(256 * 1024).fill(0x61);
      const body = multipartBody(boundary, [
        { name: "apk", filename: "a.apk", data: file },
      ]);
      const chunks = splitEvery(body, 64);
      let pulls = 0;
      let releaseWrite!: () => void;
      let writerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        writerStarted = resolve;
      });
      let firstWrite = true;
      const staging = stageMultipartUpload(
        multipartRequest(boundary, chunks, {
          onPull: () => pulls++,
        }),
        {
          ...baseOptions(root, body.byteLength, file.byteLength),
          highWaterMark: 64,
          fileHighWaterMark: 64,
          writerFactory: () =>
            new Writable({
              highWaterMark: 1,
              write(_chunk, _encoding, callback) {
                if (!firstWrite) {
                  callback();
                  return;
                }
                firstWrite = false;
                releaseWrite = callback;
                writerStarted();
              },
            }),
        },
      );

      await started;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(pulls).toBeLessThan(chunks.length);
      releaseWrite();

      const staged = await staging;
      expect(staged.size).toBe(file.byteLength);
      await staged.cleanup();
      await expectNoUploads(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
