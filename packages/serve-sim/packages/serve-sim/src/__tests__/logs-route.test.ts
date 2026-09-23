import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import type { IncomingMessage, ServerResponse } from "http";
import { handleLogsRequest } from "../middleware";
import { createLogBufferCache, type LogBufferCache } from "../log-buffer";
import { inProcessServeSimState } from "../state";

const UDID = "UDID-1";
const state = inProcessServeSimState(UDID, 4000);

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & { destroy: () => void };
  readonly stderr = new EventEmitter();
  killed = false;
  constructor() {
    super();
    this.stdout.destroy = () => {};
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  emitLines(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }
}

type FakeRes = ServerResponse & {
  statusCode_: number;
  headers_: Record<string, string>;
  body_: string;
  endStream: () => void;
};

function fakeReq(headers: Record<string, string> = {}, destroyed = false): IncomingMessage {
  return Object.assign(new EventEmitter(), { headers, destroyed }) as unknown as IncomingMessage;
}

function fakeRes(): FakeRes {
  let ended = false;
  const res = {
    statusCode_: 0,
    headers_: {} as Record<string, string>,
    body_: "",
    get writableEnded() {
      return ended;
    },
    endStream() {
      ended = true;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode_ = status;
      if (headers) res.headers_ = headers;
      return res;
    },
    write(chunk: string) {
      res.body_ += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) res.body_ += chunk;
      ended = true;
      return res;
    },
  };
  return res as unknown as FakeRes;
}

let spawned: FakeChild[] = [];
let cache: LogBufferCache;

function warmWith(lines: string[]): void {
  cache.ensure(UDID);
  spawned[0]!.emitLines(lines.join("\n") + "\n");
}

function dataFrames(body: string): string[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice("data: ".length));
}

beforeEach(() => {
  spawned = [];
  cache = createLogBufferCache({
    spawnLogStream: () => {
      const child = new FakeChild();
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
    maxBytes: 4096,
    restartDelayMs: 5,
    now: () => 1_000,
  });
});

describe("handleLogsRequest", () => {
  test("404s when there is no device", () => {
    const res = fakeRes();
    handleLogsRequest(fakeReq(), res, null, "/logs", cache);
    expect(res.statusCode_).toBe(404);
  });

  test("defaults to SSE", () => {
    const res = fakeRes();
    handleLogsRequest(fakeReq(), res, state, "/logs", cache);
    expect(res.headers_["Content-Type"]).toBe("text/event-stream");
  });

  test("replays the buffered backlog before live lines", () => {
    warmWith(['{"m":1}', '{"m":2}']);
    const res = fakeRes();

    handleLogsRequest(fakeReq(), res, state, "/logs", cache);
    expect(dataFrames(res.body_)).toEqual(['{"m":1}', '{"m":2}']);

    spawned[0]!.emitLines('{"m":3}\n');
    expect(dataFrames(res.body_)).toEqual(['{"m":1}', '{"m":2}', '{"m":3}']);
  });

  test("does not duplicate a line across the replay-to-live handover", () => {
    warmWith(['{"m":1}']);
    const res = fakeRes();
    handleLogsRequest(fakeReq(), res, state, "/logs", cache);

    spawned[0]!.emitLines('{"m":2}\n');

    expect(dataFrames(res.body_)).toEqual(['{"m":1}', '{"m":2}']);
  });

  test("resumes from a cursor without replaying what the caller has", () => {
    warmWith(['{"m":1}', '{"m":2}', '{"m":3}']);
    const res = fakeRes();

    handleLogsRequest(fakeReq(), res, state, "/logs?since=2", cache);

    expect(dataFrames(res.body_)).toEqual(['{"m":3}']);
  });

  test("returns JSON when the caller accepts it", () => {
    warmWith(['{"m":1}', '{"m":2}']);
    const res = fakeRes();

    handleLogsRequest(fakeReq({ accept: "application/json" }), res, state, "/logs", cache);

    expect(res.headers_["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(res.body_);
    expect(payload.device).toBe(UDID);
    expect(payload.latestSeq).toBe(2);
    expect(payload.status).toBe("streaming");
    expect(payload.oldestSeq).toBe(1);
    expect(payload.bufferedBytes).toBeGreaterThan(0);
    expect(payload.lines.map((l: { raw: string }) => l.raw)).toEqual(['{"m":1}', '{"m":2}']);
  });

  test("returns JSON for an explicit snapshot query", () => {
    warmWith(['{"m":1}']);
    const res = fakeRes();

    handleLogsRequest(fakeReq(), res, state, "/logs?snapshot=1", cache);

    expect(res.headers_["Content-Type"]).toBe("application/json");
    expect(JSON.parse(res.body_).lines).toHaveLength(1);
  });

  test("applies since and limit in snapshot mode", () => {
    warmWith(['{"m":1}', '{"m":2}', '{"m":3}', '{"m":4}']);
    const res = fakeRes();

    handleLogsRequest(fakeReq(), res, state, "/logs?snapshot=1&since=1&limit=2", cache);

    expect(JSON.parse(res.body_).lines.map((l: { seq: number }) => l.seq)).toEqual([3, 4]);
  });

  test("envelope wraps each frame with its cursor", () => {
    warmWith(['{"m":1}']);
    const res = fakeRes();

    handleLogsRequest(fakeReq(), res, state, "/logs?envelope=1", cache);
    spawned[0]!.emitLines('{"m":2}\n');

    const frames = dataFrames(res.body_).map((f) => JSON.parse(f));
    expect(frames).toEqual([
      { seq: 1, at: 1_000, raw: '{"m":1}' },
      { seq: 2, at: 1_000, raw: '{"m":2}' },
    ]);
  });

  test("treats an empty limit as absent rather than zero", () => {
    warmWith(['{"m":1}', '{"m":2}']);
    const res = fakeRes();

    handleLogsRequest(fakeReq(), res, state, "/logs?snapshot=1&limit=", cache);

    expect(JSON.parse(res.body_).lines).toHaveLength(2);
  });

  test("treats envelope=0 and snapshot=0 as off", () => {
    warmWith(['{"m":1}']);
    const envelopeOff = fakeRes();
    handleLogsRequest(fakeReq(), envelopeOff, state, "/logs?envelope=0", cache);
    expect(dataFrames(envelopeOff.body_)).toEqual(['{"m":1}']);

    const snapshotOff = fakeRes();
    handleLogsRequest(fakeReq(), snapshotOff, state, "/logs?snapshot=0", cache);
    expect(snapshotOff.headers_["Content-Type"]).toBe("text/event-stream");
  });

  test("lets snapshot=0 keep SSE for a caller that also accepts JSON", () => {
    warmWith(['{"m":1}']);
    const res = fakeRes();
    handleLogsRequest(fakeReq({ accept: "application/json" }), res, state, "/logs?snapshot=0", cache);
    expect(res.headers_["Content-Type"]).toBe("text/event-stream");
    expect(dataFrames(res.body_)).toEqual(['{"m":1}']);
  });

  test("ignores a nonsense cursor rather than failing", () => {
    warmWith(['{"m":1}']);
    const res = fakeRes();

    handleLogsRequest(fakeReq(), res, state, "/logs?snapshot=1&since=abc", cache);

    expect(JSON.parse(res.body_).lines).toHaveLength(1);
  });

  test("JSON snapshot does not start simctl unless follow is set", () => {
    expect(cache.peek(UDID)).toBeNull();
    handleLogsRequest(fakeReq({ accept: "application/json" }), fakeRes(), state, "/logs", cache);
    expect(cache.peek(UDID)).toBeNull();

    handleLogsRequest(
      fakeReq({ accept: "application/json" }),
      fakeRes(),
      state,
      "/logs?follow=1",
      cache
    );
    expect(cache.peek(UDID)).not.toBeNull();
    expect(spawned).toHaveLength(1);
  });

  test("snapshot=1 with follow warms the ring the same way", () => {
    expect(cache.peek(UDID)).toBeNull();
    handleLogsRequest(fakeReq(), fakeRes(), state, "/logs?snapshot=1&follow=1", cache);
    expect(cache.peek(UDID)).not.toBeNull();
  });

  test("warms the buffer for a device nothing had touched", () => {
    expect(cache.peek(UDID)).toBeNull();
    handleLogsRequest(fakeReq(), fakeRes(), state, "/logs", cache);
    expect(cache.peek(UDID)).not.toBeNull();
  });

  test("stops writing to a closed stream, leaving the shared tail warm", () => {
    cache.ensure(UDID);
    const req = fakeReq();
    const res = fakeRes();
    handleLogsRequest(req, res, state, "/logs", cache);

    req.emit("close");
    res.endStream();
    spawned[0]!.emitLines('{"m":"after close"}\n');

    expect(res.body_).not.toContain("after close");
    expect(spawned[0]!.killed).toBe(false);
  });
});
