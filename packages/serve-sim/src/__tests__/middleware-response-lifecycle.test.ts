import { describe, expect, test } from "bun:test";
import type { ServerResponse } from "http";
import {
  connectToFetch,
  type ConnectMiddleware,
} from "../connect-to-fetch";

describe("fetch middleware response lifecycle", () => {
  test("copies chunks before enqueueing them into the Fetch response", async () => {
    const source = new Uint8Array([1, 2, 3]);
    const handler: ConnectMiddleware = async (_req, res) => {
      res.write(source);
      source.fill(9);
      res.end();
    };

    const response = await connectToFetch(handler, new Request("http://localhost/stream"));

    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("releases retained write chunks after copying them", async () => {
    let released = false;
    const handler: ConnectMiddleware = async (_req, res) => {
      res.write(new Uint8Array([1]), () => {
        released = true;
      });
      res.end();
    };

    const response = await connectToFetch(handler, new Request("http://localhost/stream"));

    expect(released).toBe(true);
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(new Uint8Array([1]));
  });

  test("emits close with writableFinished after a normal response", async () => {
    let finishedOnClose = false;
    const handler: ConnectMiddleware = async (_req, res) => {
      res.once("close", () => {
        finishedOnClose = res.writableFinished;
      });
      res.end("ok");
    };

    const response = await connectToFetch(handler, new Request("http://localhost/test"));

    expect(await response?.text()).toBe("ok");
    expect(finishedOnClose).toBe(true);
  });

  test("emits close with destroyed when a streaming consumer cancels", async () => {
    let responseOnClose: ServerResponse | undefined;
    const handler: ConnectMiddleware = async (_req, res) => {
      res.once("close", () => {
        responseOnClose = res;
      });
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write("frame");
    };

    const response = await connectToFetch(handler, new Request("http://localhost/stream"));
    const reader = response!.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("frame");
    await reader.cancel();

    expect(responseOnClose?.destroyed).toBe(true);
    expect(responseOnClose?.writableFinished).toBe(false);
  });

  test("applies Web Stream backpressure to Connect responses", async () => {
    let firstWriteAccepted = true;
    const handler: ConnectMiddleware = async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      firstWriteAccepted = res.write("first");
      if (!firstWriteAccepted) {
        res.once("drain", () => res.end("second"));
      }
    };

    const response = await connectToFetch(handler, new Request("http://localhost/stream"));
    expect(firstWriteAccepted).toBe(false);
    expect(await response?.text()).toBe("firstsecond");
  });

  test("honors statusCode assignments made before end", async () => {
    const handler: ConnectMiddleware = async (_req, res) => {
      res.statusCode = 404;
      res.end("missing");
    };

    const response = await connectToFetch(handler, new Request("http://localhost/missing"));
    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe("missing");
  });

  test("propagates an aborted Fetch request to the Connect request", async () => {
    const controller = new AbortController();
    let requestClosed = false;
    const handler: ConnectMiddleware = async (req, res) => {
      req.once("close", () => {
        requestClosed = true;
        res.destroy();
      });
      res.write("frame");
    };

    const response = await connectToFetch(
      handler,
      new Request("http://localhost/stream", { signal: controller.signal }),
    );
    controller.abort();
    await response?.body?.cancel().catch(() => {});
    expect(requestClosed).toBe(true);
  });

  test("aborts the Connect request when reading the Fetch body fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("body read failed"));
      },
    });
    const handler: ConnectMiddleware = async (req, res) => {
      req.once("aborted", () => {
        res.statusCode = 400;
        res.end("aborted");
      });
    };
    const request = new Request("http://localhost/settings", {
      method: "PATCH",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await connectToFetch(handler, request);

    expect(response?.status).toBe(400);
    expect(await response?.text()).toBe("aborted");
  });

  test("aborts the Connect request when its Fetch body is already locked", async () => {
    const request = new Request("http://localhost/settings", {
      method: "PATCH",
      body: new ReadableStream<Uint8Array>(),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const reader = request.body!.getReader();
    const handler: ConnectMiddleware = async (req, res) => {
      req.once("aborted", () => {
        res.statusCode = 400;
        res.end("aborted");
      });
    };

    const response = await connectToFetch(handler, request);
    reader.releaseLock();

    expect(response?.status).toBe(400);
    expect(await response?.text()).toBe("aborted");
  });

  test("cancels a pending body read when the Fetch request is aborted", async () => {
    const requestController = new AbortController();
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const handler: ConnectMiddleware = async (_req, res) => {
      res.write("streaming");
    };
    const request = new Request("http://localhost/settings", {
      method: "PATCH",
      body,
      duplex: "half",
      signal: requestController.signal,
    } as RequestInit & { duplex: "half" });

    const response = await connectToFetch(handler, request);
    requestController.abort();
    await Bun.sleep(0);
    await response?.body?.cancel().catch(() => {});

    expect(bodyCancelled).toBe(true);
  });

  test("returns a rejection when a Connect handler throws synchronously", async () => {
    const handler = (() => {
      throw new Error("boom");
    }) as ConnectMiddleware;

    await expect(connectToFetch(handler, new Request("http://localhost/fail"))).rejects.toThrow("boom");
  });
});
