import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { IncomingMessage } from "http";
import { readRequestBodyAsync } from "../runtime-utils";

function streamedRequest(): EventEmitter & { method: string } {
  return Object.assign(new EventEmitter(), { method: "PUT" });
}

describe("readRequestBodyAsync without an async iterator", () => {
  test("reads the streamed body and drops its listeners", async () => {
    const req = streamedRequest();
    const body = readRequestBodyAsync(req as unknown as IncomingMessage);
    req.emit("data", Buffer.from("hello "));
    req.emit("data", "world");
    req.emit("end");
    expect((await body)?.toString()).toBe("hello world");
    expect(req.eventNames()).toEqual([]);
  });

  test("rejects an aborted request and drops its listeners", async () => {
    const req = streamedRequest();
    const body = readRequestBodyAsync(req as unknown as IncomingMessage);
    req.emit("data", Buffer.from("partial"));
    req.emit("aborted");
    await expect(body).rejects.toThrow("Request aborted");
    expect(req.eventNames()).toEqual([]);
  });
});
