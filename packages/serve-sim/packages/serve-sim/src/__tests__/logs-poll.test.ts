import { describe, expect, test } from "bun:test";
import {
  logsSnapshotUrl,
  parseLogSnapshot,
  startLogsPoll,
  type LogSnapshotLine,
} from "../client/utils/logs-poll";

const raw = JSON.stringify({
  timestamp: "2026-08-28 12:54:11.123456-0700",
  processImagePath: "/SpringBoard.app/SpringBoard",
  eventMessage: "hello",
  messageType: "Default",
  processID: 1,
});

describe("logsSnapshotUrl", () => {
  test("asks for a JSON follow snapshot, not SSE", () => {
    const url = logsSnapshotUrl("/logs?device=UDID", 0);
    const params = new URL(url, "http://127.0.0.1").searchParams;
    expect(params.get("snapshot")).toBe("1");
    expect(params.get("follow")).toBe("1");
    expect(params.get("since")).toBeNull();
    expect(params.get("limit")).toBe("400");
    expect(params.get("envelope")).toBeNull();
  });

  test("resumes from a cursor with a larger page", () => {
    const url = logsSnapshotUrl("/.sim/logs?device=UDID", 12);
    const params = new URL(url, "http://127.0.0.1").searchParams;
    expect(params.get("since")).toBe("12");
    expect(params.get("limit")).toBe("800");
    expect(url.startsWith("/.sim/logs?")).toBe(true);
  });
});

describe("parseLogSnapshot", () => {
  test("keeps parseable lines and the server cursor", () => {
    const parsed = parseLogSnapshot({
      latestSeq: 4,
      lines: [
        { seq: 3, raw },
        { seq: 4, raw: "not-json" },
        { seq: 5 },
      ],
    })!;
    expect(parsed.latestSeq).toBe(4);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]?.seq).toBe(3);
    expect(parsed.lines[0]?.fields.message).toBe("hello");
  });

  test("rejects a payload that is not a snapshot envelope", () => {
    expect(parseLogSnapshot(null)).toBeNull();
    expect(parseLogSnapshot("nope")).toBeNull();
    expect(parseLogSnapshot({})).toBeNull();
    expect(parseLogSnapshot({ latestSeq: 4 })).toBeNull();
    expect(parseLogSnapshot({ lines: [] })).toBeNull();
  });

  test("reports the first seq the server sent, even for a row it could not parse", () => {
    const parsed = parseLogSnapshot({
      latestSeq: 8,
      lines: [
        { seq: 7, raw: "not-json" },
        { seq: 8, raw },
      ],
    })!;
    expect(parsed.firstSeq).toBe(7);
    expect(parsed.lines.map((line) => line.seq)).toEqual([8]);
  });
});

describe("startLogsPoll", () => {
  // `simAuthHeaders` reads a bare `window`, which is a ReferenceError off the browser.
  function withPreviewWindow(): () => void {
    const globals = globalThis as { window?: unknown };
    globals.window = { __SIM_PREVIEW__: { execToken: "test-token" } };
    return () => delete globals.window;
  }

  test("delivers a live reply and advances the cursor", async () => {
    const restoreWindow = withPreviewWindow();
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ lines: [{ seq: 7, raw }], latestSeq: 7 }), {
          headers: { "Content-Type": "application/json" },
        })
      )) as unknown as typeof fetch;

    const batches: LogSnapshotLine[][] = [];
    const errors: boolean[] = [];
    let since = 0;
    const stop = startLogsPoll("/logs", {
      getSince: () => since,
      setSince: (seq) => {
        since = seq;
      },
      onBatch: (lines) => batches.push(lines),
      onError: (errored) => errors.push(errored),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    globalThis.fetch = original;
    restoreWindow();

    expect(errors).toEqual([false]);
    expect(since).toBe(7);
    expect(batches.flat().map((line) => line.seq)).toEqual([7]);
  });

  async function pollOnce(since: number, reply: { lines: { seq: number; raw: string }[]; latestSeq: number }) {
    const restoreWindow = withPreviewWindow();
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } })
      )) as unknown as typeof fetch;

    const batches: LogSnapshotLine[][] = [];
    let cursor = since;
    const stop = startLogsPoll("/logs", {
      getSince: () => cursor,
      setSince: (seq) => {
        cursor = seq;
      },
      onBatch: (lines) => batches.push(lines),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    globalThis.fetch = original;
    restoreWindow();
    return { lines: batches.flat(), cursor };
  }

  test("marks the lines a capped reply skipped instead of dropping them silently", async () => {
    const { lines, cursor } = await pollOnce(3, {
      lines: [{ seq: 10, raw }, { seq: 11, raw }],
      latestSeq: 11,
    });

    expect(cursor).toBe(11);
    expect(lines.map((line) => line.seq)).toEqual([4, 10, 11]);
    expect(lines[0]!.fields.message).toBe("6 lines skipped");
  });

  test("adds no marker when the reply's first row is one it could not parse", async () => {
    const empty = JSON.stringify({ processImagePath: "/x/Demo", eventMessage: "" });
    const { lines } = await pollOnce(10, {
      lines: [{ seq: 11, raw: empty }, { seq: 12, raw }],
      latestSeq: 12,
    });

    expect(lines.map((line) => line.seq)).toEqual([12]);
  });

  test("says line, not lines, for a single skipped line", async () => {
    const { lines } = await pollOnce(3, { lines: [{ seq: 5, raw }], latestSeq: 5 });

    expect(lines[0]!.fields.message).toBe("1 line skipped");
  });

  test("adds no marker when the reply picks up right after the cursor", async () => {
    const { lines } = await pollOnce(6, { lines: [{ seq: 7, raw }], latestSeq: 7 });

    expect(lines.map((line) => line.seq)).toEqual([7]);
  });

  test("reports a failed request without moving the cursor", async () => {
    const restoreWindow = withPreviewWindow();
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response("nope", { status: 503 }))) as unknown as typeof fetch;

    const errors: boolean[] = [];
    let since = 3;
    const stop = startLogsPoll("/logs", {
      getSince: () => since,
      setSince: (seq) => {
        since = seq;
      },
      onBatch: () => {},
      onError: (errored) => errors.push(errored),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    stop();
    globalThis.fetch = original;
    restoreWindow();

    expect(errors).toContain(true);
    expect(since).toBe(3);
  });

  test("keeps its cursor and reports an error when a 200 reply is not a snapshot", async () => {
    const restoreWindow = withPreviewWindow();
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("{}", { headers: { "Content-Type": "application/json" } })
      )) as unknown as typeof fetch;

    const errors: boolean[] = [];
    let since = 500;
    const stop = startLogsPoll("/logs", {
      getSince: () => since,
      setSince: (seq) => {
        since = seq;
      },
      onBatch: () => {},
      onError: (errored) => errors.push(errored),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    globalThis.fetch = original;
    restoreWindow();

    expect(since).toBe(500);
    expect(errors).toContain(true);
  });

  test("rewinds when the server hands back a fresh buffer", async () => {
    const restoreWindow = withPreviewWindow();
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ lines: [{ seq: 1, raw }], latestSeq: 1 }), {
          headers: { "Content-Type": "application/json" },
        })
      )) as unknown as typeof fetch;

    const batches: LogSnapshotLine[][] = [];
    let since = 5_000;
    const stop = startLogsPoll("/logs", {
      getSince: () => since,
      setSince: (seq) => {
        since = seq;
      },
      onBatch: (lines) => batches.push(lines),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    globalThis.fetch = original;
    restoreWindow();

    expect(since).toBe(0);
    expect(batches).toEqual([]);
  });

  test("drops a reply that lands after the caller stopped", async () => {
    const restoreWindow = withPreviewWindow();
    const original = globalThis.fetch;
    const replied = Promise.withResolvers<Response>();
    let requestSignal: AbortSignal | null = null;
    globalThis.fetch = ((_url: unknown, init: RequestInit) => {
      requestSignal = init.signal ?? null;
      return replied.promise;
    }) as unknown as typeof fetch;

    const batches: LogSnapshotLine[][] = [];
    let since = 0;
    const stop = startLogsPoll("/logs", {
      getSince: () => since,
      setSince: (seq) => {
        since = seq;
      },
      onBatch: (lines) => batches.push(lines),
    });

    stop();
    expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
    replied.resolve(
      new Response(JSON.stringify({ lines: [{ seq: 7, raw }], latestSeq: 7 }), {
        headers: { "Content-Type": "application/json" },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    globalThis.fetch = original;
    restoreWindow();

    expect(batches).toEqual([]);
    expect(since).toBe(0);
  });
});
