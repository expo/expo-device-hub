import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openSseStream } from "../sse-stream";

function connection() {
  const chunks: string[] = [];
  const req = new EventEmitter() as IncomingMessage;
  const res = Object.assign(new EventEmitter(), {
    writeHead: () => {}, write: (chunk: string) => chunks.push(chunk),
  }) as unknown as ServerResponse;
  return { req, res, chunks };
}

test("either side closing releases all readers exactly once", () => {
  const { req, res, chunks } = connection();
  const stream = openSseStream(req, res);
  let released = 0;
  stream.onClose(() => { released += 1; });
  stream.onClose(() => { throw new Error("reader teardown failed"); });
  res.emit("close");
  req.emit("close");
  stream.write("late data");
  stream.onClose(() => { released += 1; });
  expect(released).toBe(2);
  expect(stream.isOpen()).toBe(false);
  expect(chunks).toEqual([":\n\n"]);
  expect(req.listenerCount("close")).toBe(0);
  expect(res.listenerCount("close")).toBe(0);
});

test("an already-abandoned request immediately releases a newly attached reader", () => {
  const { req, res } = connection();
  Object.defineProperty(req, "destroyed", { value: true });
  const stream = openSseStream(req, res);
  let released = false;
  stream.onClose(() => { released = true; });
  expect(released).toBe(true);
  expect(stream.isOpen()).toBe(false);
});
