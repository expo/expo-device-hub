import { expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "http";

import { connectToFetch } from "../connect-to-fetch";

// A route that awaits before it listens for "close" can only learn that the client
// left through `req.destroyed`, as with a Node request.
async function destroyedAfterLeaving(leave: (controller: AbortController, response: Response) => Promise<void>) {
  const controller = new AbortController();
  let req!: IncomingMessage;
  const handled = Promise.withResolvers<void>();
  const response = await connectToFetch(async (request: IncomingMessage, res: ServerResponse) => {
    req = request;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(":\n\n");
    handled.resolve();
  }, new Request("http://127.0.0.1/stream", { signal: controller.signal }));
  await handled.promise;
  expect(req.destroyed).toBe(false);
  await leave(controller, response!);
  return req.destroyed;
}

test("req.destroyed turns true when the client aborts", async () => {
  expect(await destroyedAfterLeaving(async (controller) => controller.abort())).toBe(true);
});

test("req.destroyed turns true when the response body is cancelled", async () => {
  expect(await destroyedAfterLeaving(async (_, response) => response.body!.cancel())).toBe(true);
});
