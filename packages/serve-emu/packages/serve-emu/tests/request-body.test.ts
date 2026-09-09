import { describe, expect, test } from "bun:test";
import {
  HttpBodyError,
  MAX_REQUEST_BODY_CHUNKS,
  readBodyLimited,
  readJsonLimited,
} from "../src/request-body.ts";

const encoder = new TextEncoder();

function requestWithChunks(
  chunks: Array<string | Uint8Array>,
  options: {
    headers?: HeadersInit;
    signal?: AbortSignal;
    onCancel?: (reason: unknown) => void;
  } = {},
): Request {
  const encoded = chunks.map((chunk) =>
    typeof chunk === "string" ? encoder.encode(chunk) : chunk,
  );
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = encoded[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel(reason) {
      options.onCancel?.(reason);
    },
  });
  return new Request("http://localhost/test", {
    method: "POST",
    headers: options.headers,
    body,
    signal: options.signal,
  });
}

async function expectBodyError(
  promise: Promise<unknown>,
  code: HttpBodyError["code"],
  status: number,
): Promise<HttpBodyError> {
  let error: unknown;
  try {
    await promise;
    error = new Error("expected request body read to fail");
  } catch (cause) {
    error = cause;
  }
  expect(error).toBeInstanceOf(HttpBodyError);
  expect((error as HttpBodyError).code).toBe(code);
  expect((error as HttpBodyError).status).toBe(status);
  return error as HttpBodyError;
}

describe("readBodyLimited", () => {
  test("accepts a body exactly at the declared limit", async () => {
    const request = requestWithChunks(["ab", "cd"], {
      headers: { "content-length": "4" },
    });

    const body = await readBodyLimited(request, 4);

    expect(new TextDecoder().decode(body)).toBe("abcd");
  });

  test("rejects and cancels when streamed bytes exceed the limit", async () => {
    const cancellations: unknown[] = [];
    const request = requestWithChunks(["abcd", "e"], {
      onCancel: (reason) => cancellations.push(reason),
    });

    const error = await expectBodyError(
      readBodyLimited(request, 4),
      "payload-too-large",
      413,
    );
    expect(error.limit).toBe(4);
    expect(error.received).toBe(5);
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toBeInstanceOf(HttpBodyError);
  });

  test("accepts fragmented chunked input without Content-Length", async () => {
    const request = requestWithChunks(["a", "bc", "d"], {
      headers: { "transfer-encoding": "chunked" },
    });

    expect(new TextDecoder().decode(await readBodyLimited(request, 4))).toBe(
      "abcd",
    );
  });

  test("accepts 200,000 one-byte chunks while letting timers advance", async () => {
    const byteLength = 200_000;
    let emitted = 0;
    let readCompleted = false;
    let timerRanDuringRead = false;
    const progressTimer = setTimeout(() => {
      timerRanDuringRead = !readCompleted;
    }, 0);
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted === byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(Uint8Array.of(emitted++ & 0xff));
        },
      }),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("fragmented body read timed out")),
        2_000,
      );
    });

    try {
      const body = await Promise.race([
        readBodyLimited(request, byteLength),
        timeout,
      ]);
      readCompleted = true;
      expect(body.byteLength).toBe(byteLength);
      expect(body[0]).toBe(0);
      expect(body[byteLength - 1]).toBe((byteLength - 1) & 0xff);
      expect(timerRanDuringRead).toBe(true);
    } finally {
      readCompleted = true;
      clearTimeout(progressTimer);
      if (timer) clearTimeout(timer);
    }
  });

  test("rejects and cancels the body when the chunk limit is exceeded", async () => {
    const cancellations: unknown[] = [];
    let emitted = 0;
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(Uint8Array.of(emitted++ & 0xff));
        },
        cancel(reason) {
          cancellations.push(reason);
        },
      }),
    });

    const error = await expectBodyError(
      readBodyLimited(request, MAX_REQUEST_BODY_CHUNKS + 1),
      "too-many-body-chunks",
      413,
    );

    expect(error.limit).toBe(MAX_REQUEST_BODY_CHUNKS);
    expect(error.received).toBe(MAX_REQUEST_BODY_CHUNKS + 1);
    expect(emitted).toBeGreaterThanOrEqual(MAX_REQUEST_BODY_CHUNKS + 1);
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toBe(error);
  });

  test("rejects an oversized declared length before reading", async () => {
    const cancellations: unknown[] = [];
    const request = requestWithChunks(["a"], {
      headers: { "content-length": "5" },
      onCancel: (reason) => cancellations.push(reason),
    });

    await expectBodyError(
      readBodyLimited(request, 4),
      "payload-too-large",
      413,
    );
    expect(cancellations).toHaveLength(1);
  });

  test("does not trust an understated Content-Length", async () => {
    const request = requestWithChunks(["abc", "de"], {
      headers: { "content-length": "1" },
    });

    await expectBodyError(
      readBodyLimited(request, 4),
      "payload-too-large",
      413,
    );
  });

  test.each(["abc", "-1", "+1", "1.5", "1, 1"])(
    "rejects invalid Content-Length %p",
    async (contentLength) => {
      const request = requestWithChunks(["a"], {
        headers: { "content-length": contentLength },
      });

      await expectBodyError(
        readBodyLimited(request, 4),
        "invalid-content-length",
        400,
      );
    },
  );

  test("honors an already-aborted external signal and cancels the body", async () => {
    const controller = new AbortController();
    const reason = new Error("server stopping");
    const cancellations: unknown[] = [];
    controller.abort(reason);
    const request = requestWithChunks(["body"], {
      onCancel: (cancelReason) => cancellations.push(cancelReason),
    });

    const error = await expectBodyError(
      readBodyLimited(request, 10, controller.signal),
      "request-aborted",
      499,
    );
    expect(error.cause).toBe(reason);
    expect(cancellations).toHaveLength(1);
  });

  test("cancels a pending read when the Request signal aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("client disconnected");
    const cancellations: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({
      cancel(cancelReason) {
        cancellations.push(cancelReason);
      },
    });
    const request = new Request("http://localhost/test", {
      method: "POST",
      body,
      signal: controller.signal,
    });

    const reading = readBodyLimited(request, 10);
    await Promise.resolve();
    controller.abort(reason);

    const error = await expectBodyError(
      reading,
      "request-aborted",
      499,
    );
    expect(error.cause).toBe(reason);
    expect(cancellations).toHaveLength(1);
  });

  test("wraps stream failures and cancels the reader", async () => {
    const sourceError = new Error("socket failed");
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(sourceError);
        },
      }),
    });

    const error = await expectBodyError(
      readBodyLimited(request, 10),
      "body-read-failed",
      400,
    );
    expect(error.cause).toBe(sourceError);
  });
});

describe("readJsonLimited", () => {
  test("parses bounded JSON", async () => {
    const request = requestWithChunks(['{"ok":', "true}"]);

    expect(await readJsonLimited(request, 32)).toEqual({ ok: true });
  });

  test("reports malformed JSON as a typed 400 error", async () => {
    const request = requestWithChunks(['{"ok":']);

    await expectBodyError(
      readJsonLimited(request, 32),
      "invalid-json",
      400,
    );
  });

  test("preserves body limit errors instead of reclassifying them", async () => {
    const request = requestWithChunks(['{"tooLong":true}']);

    await expectBodyError(
      readJsonLimited(request, 4),
      "payload-too-large",
      413,
    );
  });
});
