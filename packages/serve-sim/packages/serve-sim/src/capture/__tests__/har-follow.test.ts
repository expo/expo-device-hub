import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toHarEntry } from "../har";
import { captureHarPaths, followCaptureHar } from "../har-follow";

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A server with no session HAR yet: the follower's seed request finds nothing. */
function withoutSession(fetchImpl: FetchStub): FetchStub {
  return async (input, init) =>
    String(input).includes("/network-capture.har") ? new Response("", { status: 404 }) : fetchImpl(input, init);
}

describe("followCaptureHar", () => {
  it("fails promptly when the capture stream reports no active recording", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-disabled-"));
    try {
      for (const attachment of ["not-enabled", "failed"]) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              `data: ${JSON.stringify({ type: "meta", meta: { attachment, attachError: "Capture is unavailable" } })}\n\n`,
            ));
          },
        });
        await expect(followCaptureHar({
          baseUrl: "http://127.0.0.1:3999", device: "D", outPath: join(dir, `${attachment}.har`), token: "test",
          fetchImpl: withoutSession(async () => new Response(stream)),
        })).rejects.toThrow("Capture is unavailable");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a failed flush even when the stream was aborted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-abort-"));
    let abortStream = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"finished","request":{"id":"r1","method":"GET","url":"https://a.test/","status":200,"mimeType":"text/plain","requestBytes":0,"responseBytes":2,"startedAt":1,"ttfbMs":1,"durationMs":2,"failure":null}}\n\n'));
        abortStream = () => controller.error(new DOMException("Stopped", "AbortError"));
      },
    });
    try {
      await expect(followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath: join(dir, "session.har"), token: "test",
        fetchImpl: withoutSession(async (input) => {
          if (String(input).includes("/network-capture/r1")) {
            rmSync(dir, { recursive: true, force: true });
            abortStream();
            return new Response("null");
          }
          return new Response(stream);
        }),
      })).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases the writer after the initial fetch fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-fetch-"));
    const options = { baseUrl: "http://127.0.0.1:3999", device: "D", outPath: join(dir, "session.har"), token: "test" };
    const abort = new DOMException("Stopped", "AbortError");
    try {
      await expect(followCaptureHar({ ...options, fetchImpl: async () => { throw abort; } })).rejects.toBe(abort);
      const result = await followCaptureHar({ ...options, fetchImpl: withoutSession(async () => new Response("")) });
      expect(result.size).toBe(0);
      expect(existsSync(result.harPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accumulates SSE frames and rewrites the HAR file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-"));
    const outPath = join(dir, "session.har");

    const frames = [
      "event: meta\ndata: {\"schemaVersion\":1,\"udid\":\"D\",\"attachment\":\"capturing\"}\n\n",
      'data: {"type":"started","request":{"id":"r1","method":"GET","url":"https://a.test/","status":null,"mimeType":null,"requestBytes":0,"responseBytes":0,"startedAt":1,"ttfbMs":null,"durationMs":null,"failure":null}}\n\n',
      'data: {"type":"finished","request":{"id":"r1","method":"GET","url":"https://a.test/","status":200,"mimeType":"text/plain","requestBytes":0,"responseBytes":2,"startedAt":1,"ttfbMs":1,"durationMs":2,"failure":null}}\n\n',
    ];
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= frames.length) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(frames[i++]));
      },
    });

    const fetchImpl = withoutSession(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/network-capture/r1")) {
        return new Response(
          JSON.stringify({
            requestHeaders: {},
            responseHeaders: { "content-type": "text/plain" },
            requestBody: null,
            responseBody: "ok",
            requestTruncated: false,
            responseTruncated: false,
            requestBinary: false,
            responseBinary: false,
          }),
          { status: 200 },
        );
      }
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    try {
      const result = await followCaptureHar({
        baseUrl: "http://127.0.0.1:3999",
        device: "D",
        outPath,
        flushIntervalMs: 50,
        fetchImpl,
        version: "test",
        token: "test-token",
      });
      expect(result.size).toBe(1);
      const har = JSON.parse(readFileSync(outPath, "utf8"));
      expect(har.log.entries).toHaveLength(1);
      expect(har.log.entries[0].response.content.text).toBe("ok");

      expect(result.eventsPath).toBe(outPath.replace(/\.har$/, ".network-capture.json"));
      const events = readFileSync(result.eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string });
      expect(events.some((e) => e.type === "started")).toBe(true);
      expect(events.some((e) => e.type === "finished")).toBe(true);
      expect(existsSync(result.entriesPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails rather than naming a HAR the last write never produced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-gone-"));
    const outPath = join(dir, "session.har");

    const frames = [
      'data: {"type":"finished","request":{"id":"r1","method":"GET","url":"https://a.test/","status":200,"mimeType":"text/plain","requestBytes":0,"responseBytes":2,"startedAt":1,"ttfbMs":1,"durationMs":2,"failure":null}}\n\n',
    ];
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= frames.length) {
          // The output directory disappears under the writer, the way a cleaned temp dir would.
          rmSync(dir, { recursive: true, force: true });
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(frames[i++]));
      },
    });
    const fetchImpl = withoutSession(async (input: RequestInfo | URL) => {
      if (String(input).includes("/network-capture/r1")) return new Response("null", { status: 200 });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    try {
      await expect(
        followCaptureHar({
          baseUrl: "http://127.0.0.1:3999",
          device: "D",
          outPath,
          flushIntervalMs: 50,
          fetchImpl,
          version: "test",
          token: "test-token",
        }),
      ).rejects.toThrow(/ENOENT/);
      expect(existsSync(outPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("followCaptureHar started late", () => {
  const request = (id: string, startedAt: number) => ({
    id, method: "GET", url: `https://a.test/${id}`, status: 200, mimeType: "text/plain",
    requestBytes: 0, responseBytes: 2, startedAt, ttfbMs: 1, durationMs: 2, failure: null,
  });

  it("keeps requests the session recorded before it started, once each", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-late-"));
    const outPath = join(dir, "session.har");
    // The session HAR holds r1-r3; the live store has already evicted r1 and replays r2-r3.
    const sessionHar = {
      log: {
        version: "1.2",
        creator: { name: "@expo/serve-sim", version: "test" },
        entries: [1, 2, 3].map((n) => toHarEntry(request(`r${n}`, n))),
      },
    };
    const frames = [2, 3, 4].map((n) => `data: ${JSON.stringify({ type: "finished", request: request(`r${n}`, n) })}\n\n`);
    const bodyFetches: string[] = [];
    try {
      const result = await followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test", flushIntervalMs: 50,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/network-capture.har")) return new Response(JSON.stringify(sessionHar));
          if (url.includes("/network-capture/")) {
            bodyFetches.push(new URL(url).pathname.split("/").pop()!);
            return new Response("null");
          }
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
              controller.close();
            },
          }));
        },
      });
      expect(result.size).toBe(4);
      const har = JSON.parse(readFileSync(outPath, "utf8")) as { log: { entries: { _captureId: string }[] } };
      expect(har.log.entries.map((entry) => entry._captureId)).toEqual(["r1", "r2", "r3", "r4"]);
      expect(bodyFetches).toEqual(["r4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("followCaptureHar under an embedded mount", () => {
  it("reads the stream and bodies below the mount prefix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-mount-"));
    const requested: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"finished","request":{"id":"r1","method":"GET","url":"https://a.test/","status":200,"mimeType":"text/plain","requestBytes":0,"responseBytes":2,"startedAt":1,"ttfbMs":1,"durationMs":2,"failure":null}}\n\n'));
        controller.close();
      },
    });
    try {
      await followCaptureHar({
        baseUrl: "http://127.0.0.1:3200/.sim", device: "D", outPath: join(dir, "session.har"), token: "test",
        fetchImpl: async (input) => {
          requested.push(String(input));
          if (String(input).includes("/network-capture.har")) return new Response("", { status: 404 });
          return String(input).includes("/network-capture/") ? new Response("null") : new Response(stream);
        },
      });
      expect(requested).toEqual([
        "http://127.0.0.1:3200/.sim/network-capture.har?device=D",
        "http://127.0.0.1:3200/.sim/network-capture?device=D",
        "http://127.0.0.1:3200/.sim/network-capture/r1?device=D",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("capture har working files", () => {
  const finished = (id: string) =>
    `data: {"type":"finished","request":{"id":"${id}","method":"GET","url":"https://a.test/","status":200,"mimeType":"text/plain","requestBytes":0,"responseBytes":2,"startedAt":1,"ttfbMs":1,"durationMs":2,"failure":null}}\n\n`;

  function follow(outPath: string, release: Promise<void>) {
    return followCaptureHar({
      baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test", flushIntervalMs: 50,
      fetchImpl: withoutSession(async (input) => {
        if (String(input).includes("/network-capture/")) return new Response("null");
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(finished("r1")));
            await release;
            controller.close();
          },
        }));
      }),
    });
  }

  it("names them after the HAR", () => {
    expect(captureHarPaths("/out/morning.har")).toEqual({
      eventsPath: "/out/morning.network-capture.json",
      entriesPath: "/out/morning.entries.ndjson",
      ownerFile: "morning.owner.pid",
    });
  });

  it("lets two recordings share a folder at once and leaves other files alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-shared-"));
    writeFileSync(join(dir, "network-capture.json"), "mine");
    writeFileSync(join(dir, "owner.pid"), "mine");
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    try {
      const both = Promise.all([follow(join(dir, "a.har"), gate), follow(join(dir, "b.har"), gate)]);
      await Bun.sleep(100);
      release();
      const [a, b] = await both;
      expect(a.size).toBe(1);
      expect(b.size).toBe(1);
      expect(readFileSync(join(dir, "network-capture.json"), "utf8")).toBe("mine");
      expect(readFileSync(join(dir, "owner.pid"), "utf8")).toBe("mine");
      expect(existsSync(join(dir, "a.owner.pid"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an earlier recording's files when a later one starts in the same folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-later-"));
    try {
      const morning = await follow(join(dir, "morning.har"), Promise.resolve());
      const logged = readFileSync(morning.eventsPath, "utf8");
      expect(logged).toContain("finished");
      await follow(join(dir, "afternoon.har"), Promise.resolve());
      expect(readFileSync(morning.eventsPath, "utf8")).toBe(logged);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
