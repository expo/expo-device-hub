import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureHarPaths, followCaptureHar } from "../har-follow";

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
          fetchImpl: async () => new Response(stream),
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
        fetchImpl: async (input) => {
          if (String(input).includes("/network-capture/r1")) {
            rmSync(dir, { recursive: true, force: true });
            abortStream();
            return new Response("null");
          }
          return new Response(stream);
        },
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
      const result = await followCaptureHar({ ...options, fetchImpl: async () => new Response("") });
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

    const fetchImpl = async (input: RequestInfo | URL) => {
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
    };

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
    const fetchImpl = async (input: RequestInfo | URL) => {
      if (String(input).includes("/network-capture/r1")) return new Response("null", { status: 200 });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

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
          return String(input).includes("/network-capture/") ? new Response("null") : new Response(stream);
        },
      });
      expect(requested).toEqual([
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
      fetchImpl: async (input) => {
        if (String(input).includes("/network-capture/")) return new Response("null");
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(finished("r1")));
            await release;
            controller.close();
          },
        }));
      },
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
