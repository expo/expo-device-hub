import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toHarEntry } from "../har";
import { captureHarPaths, followCaptureHar, harHasEntries } from "../har-follow";

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A server with no session recording yet: the follower's seed request finds nothing. */
function withoutSession(fetchImpl: FetchStub): FetchStub {
  return async (input, init) =>
    String(input).includes("/network-capture.ndjson") ? new Response("", { status: 404 }) : fetchImpl(input, init);
}

const metaFrame = (attachment: string) =>
  `data: ${JSON.stringify({ type: "meta", meta: { attachment, attachError: null } })}\n\n`;
/** The frame the server sends once the proxy is up; the follower begins on it, not before. */
const CAPTURING = metaFrame("capturing");

/** A capture stream that shows capture is on, then ends: the follower begins and records nothing. */
function capturingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(CAPTURING));
      controller.close();
    },
  });
}

describe("harHasEntries", () => {
  const check = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-scan-"));
    try {
      writeFileSync(join(dir, "a.har"), text);
      return harHasEntries(join(dir, "a.har"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("reads log.entries, not another entries key or text inside a string", () => {
    expect(check('{"metadata":{"entries":[]},"log":{"entries":[{"request":{"url":"https://kept.test/"}}]}}')).toBe(true);
    expect(check('{"log":{"comment":"\\"entries\\":[]","entries":[{}]}}')).toBe(true);
    expect(check('{"log":{"pages":[{"entries":[]}],"entries":[]}}')).toBe(false);
  });

  it("reaches log.entries past more than one read of other data", () => {
    expect(check(`{"log":{"creator":{"comment":"${"x".repeat(200_000)}"},"entries":[ ]}}`)).toBe(false);
    expect(check(`{"log":{"creator":{"comment":"${"x".repeat(200_000)}"},"entries":[{}]}}`)).toBe(true);
  });

  it("stops at the first entry, however large the rest", () => {
    expect(check(`{\n  "log": {\n    "entries": [\n      {"text": "${"y".repeat(300_000)}`)).toBe(true);
  });

  it("cannot tell for a file that ends first or is not a JSON object", () => {
    expect(check('{"log":{"version":"1.2"')).toBeNull();
    expect(check("not json")).toBeNull();
    expect(check('{"log":{"entries":null}}')).toBeNull();
    expect(check('{"entries":[]}')).toBeNull();
  });
});

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
        controller.enqueue(new TextEncoder().encode(CAPTURING));
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
      const result = await followCaptureHar({ ...options, fetchImpl: withoutSession(async () => new Response(capturingStream())) });
      expect(result.size).toBe(0);
      expect(existsSync(result.harPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to replace a recording that holds requests unless asked to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-refuse-"));
    const outPath = join(dir, "session.har");
    const har = JSON.stringify({ log: { entries: [{ request: { url: "https://kept.test/" } }] } });
    writeFileSync(outPath, har);
    let fetched = 0;
    const options = {
      baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test",
      fetchImpl: withoutSession(async () => { fetched++; return new Response(capturingStream()); }),
    };
    try {
      await expect(followCaptureHar(options)).rejects.toThrow("already holds a recording");
      expect(fetched).toBe(0);
      expect(readFileSync(outPath, "utf8")).toBe(har);

      // An empty recording, as a stopped run with no requests leaves, is not worth protecting.
      writeFileSync(outPath, JSON.stringify({ log: { entries: [] } }));
      await followCaptureHar(options);
      expect(fetched).toBe(1);

      writeFileSync(outPath, har);
      await followCaptureHar({ ...options, replace: true });
      expect(readFileSync(outPath, "utf8")).not.toBe(har);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tells an empty HAR from one with entries without loading it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-head-"));
    const outPath = join(dir, "session.har");
    const options = {
      baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test",
      fetchImpl: withoutSession(async () => new Response(capturingStream())),
    };
    try {
      // Pretty-printed, and with an entry far larger than the part that is read.
      writeFileSync(outPath, `{\n  "log": {\n    "entries": [\n      {"response": {"content": {"text": "${"x".repeat(200_000)}"}}}\n    ]\n  }\n}\n`);
      await expect(followCaptureHar(options)).rejects.toThrow("already holds a recording");
      writeFileSync(outPath, '{\n  "log": {\n    "entries": [ ]\n  }\n}\n');
      expect((await followCaptureHar(options)).size).toBe(0);
      // An empty `entries` array outside `log` does not make a full recording look empty.
      writeFileSync(outPath, '{"metadata":{"entries":[]},"log":{"entries":[{"request":{"url":"https://kept.test/"}}]}}');
      await expect(followCaptureHar(options)).rejects.toThrow("already holds a recording");
      // More than 64 KiB before an empty `log.entries` is still read as empty.
      writeFileSync(outPath, `{"log":{"creator":{"comment":"${"x".repeat(70 * 1024)}"},"entries":[]}}`);
      expect((await followCaptureHar(options)).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an --events path that names the HAR, before touching either", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-collide-"));
    const outPath = join(dir, "a.har");
    let fetched = 0;
    try {
      await expect(followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath, eventsPath: join(dir, ".", "a.har"), token: "test",
        fetchImpl: async () => { fetched++; return new Response(capturingStream()); },
      })).rejects.toThrow("name the same file");
      expect(fetched).toBe(0);
      expect(existsSync(outPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an --events path that holds something other than an event log, and reuses its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-events-"));
    const other = join(dir, "old.har");
    const kept = '{"log":{"entries":[{"request":{"url":"https://kept.test/"}}]}}\n';
    writeFileSync(other, kept);
    const follow = (eventsPath: string, outPath: string) => followCaptureHar({
      baseUrl: "http://127.0.0.1:3999", device: "D", outPath, eventsPath, token: "test",
      fetchImpl: withoutSession(async () => new Response(capturingStream())),
    });
    try {
      await expect(follow(other, join(dir, "new.har"))).rejects.toThrow("is not a capture event log");
      expect(readFileSync(other, "utf8")).toBe(kept);
      // A rerun with the same --events replaces the event log it wrote before.
      const events = join(dir, "events.ndjson");
      await follow(events, join(dir, "a.har"));
      // A real event log from that run, not an empty file, is what the rerun accepts.
      expect(JSON.parse(readFileSync(events, "utf8").split("\n")[0]!)).toMatchObject({ type: "meta" });
      writeFileSync(join(dir, "a.har"), JSON.stringify({ log: { entries: [] } }));
      await follow(events, join(dir, "a.har"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")("treats paths that differ only in case as one file on macOS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-case-"));
    try {
      await expect(followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath: join(dir, "A.har"), eventsPath: join(dir, "a.har"), token: "test",
        fetchImpl: withoutSession(async () => new Response(capturingStream())),
      })).rejects.toThrow("name the same file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports that the recording began only once a frame shows capture is on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-begin-"));
    const options = { baseUrl: "http://127.0.0.1:3999", device: "D", outPath: join(dir, "session.har"), token: "test" };
    try {
      let began = 0;
      const abort = new DOMException("Stopped", "AbortError");
      // Stopped while the stream was still connecting: nothing began, and no HAR exists.
      await expect(followCaptureHar({ ...options, onBegin: () => void began++, fetchImpl: async () => { throw abort; } })).rejects.toBe(abort);
      expect(began).toBe(0);
      expect(existsSync(options.outPath)).toBe(false);

      await followCaptureHar({ ...options, onBegin: () => void began++, fetchImpl: withoutSession(async () => new Response(capturingStream())) });
      expect(began).toBe(1);
      expect(existsSync(options.outPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves an existing recording alone until the stream shows capture is on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-keep-"));
    const outPath = join(dir, "session.har");
    const paths = captureHarPaths(outPath);
    const kept = { har: '{"log":{"entries":["kept"]}}\n', events: "kept-event\n", entries: "kept-entry\n" };
    writeFileSync(outPath, kept.har);
    writeFileSync(paths.eventsPath, kept.events);
    writeFileSync(paths.entriesPath, kept.entries);
    // With --force; without it the follower refuses before it connects (next test).
    const options = { baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test", replace: true };
    const unchanged = () => {
      expect(readFileSync(outPath, "utf8")).toBe(kept.har);
      expect(readFileSync(paths.eventsPath, "utf8")).toBe(kept.events);
      expect(readFileSync(paths.entriesPath, "utf8")).toBe(kept.entries);
    };
    try {
      // A refused connection, a rejected request, and a device with capture off: nothing is replaced.
      await expect(followCaptureHar({ ...options, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }))
        .rejects.toThrow("ECONNREFUSED");
      unchanged();
      await expect(followCaptureHar({ ...options, fetchImpl: async () => new Response("", { status: 503 }) }))
        .rejects.toThrow("capture stream HTTP 503");
      unchanged();
      const off = JSON.stringify({ type: "meta", meta: { attachment: "not-enabled", attachError: null } });
      await expect(followCaptureHar({
        ...options,
        fetchImpl: withoutSession(async () => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${off}\n\n`));
            controller.close();
          },
        }))),
      })).rejects.toThrow("not enabled");
      unchanged();

      // Once a frame shows capture is on, the recording at --out is replaced as before.
      const result = await followCaptureHar({ ...options, fetchImpl: withoutSession(async () => new Response(capturingStream())) });
      expect(result.size).toBe(0);
      expect(readFileSync(outPath, "utf8")).not.toBe(kept.har);
      expect(readFileSync(paths.entriesPath, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a --force recording when capture fails while it is still starting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-starting-"));
    const outPath = join(dir, "session.har");
    const paths = captureHarPaths(outPath);
    const kept = { har: '{"log":{"entries":["kept"]}}\n', events: "kept-event\n", entries: "kept-entry\n" };
    writeFileSync(outPath, kept.har);
    writeFileSync(paths.eventsPath, kept.events);
    writeFileSync(paths.entriesPath, kept.entries);
    const failed = `data: ${JSON.stringify({ type: "meta", meta: { attachment: "failed", attachError: "proxy did not start" } })}\n\n`;
    let began = 0;
    try {
      await expect(followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test", replace: true, onBegin: () => void began++,
        fetchImpl: withoutSession(async () => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(metaFrame("starting")));
            controller.enqueue(new TextEncoder().encode(failed));
            controller.close();
          },
        }))),
      })).rejects.toThrow("proxy did not start");
      expect(began).toBe(0);
      expect(readFileSync(outPath, "utf8")).toBe(kept.har);
      expect(readFileSync(paths.eventsPath, "utf8")).toBe(kept.events);
      expect(readFileSync(paths.entriesPath, "utf8")).toBe(kept.entries);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails, and keeps a --force recording, when the session's earlier requests cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-seed-error-"));
    const outPath = join(dir, "session.har");
    const kept = '{"log":{"entries":["kept"]}}\n';
    writeFileSync(outPath, kept);
    try {
      await expect(followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test", replace: true,
        fetchImpl: async (input) =>
          String(input).includes("/network-capture.ndjson")
            ? new Response("disk error", { status: 500 })
            : new Response(capturingStream()),
      })).rejects.toThrow("HTTP 500");
      expect(readFileSync(outPath, "utf8")).toBe(kept);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails, and keeps a --force recording, when the session's earlier requests stop part way or hold an unreadable entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-seed-cut-"));
    const outPath = join(dir, "session.har");
    const paths = captureHarPaths(outPath);
    const kept = { har: '{"log":{"entries":["kept"]}}\n', events: "kept-event\n", entries: "kept-entry\n" };
    writeFileSync(outPath, kept.har);
    writeFileSync(paths.eventsPath, kept.events);
    writeFileSync(paths.entriesPath, kept.entries);
    const good = `${JSON.stringify(toHarEntry({
      id: "r1", method: "GET", url: "https://a.test/", status: 200, mimeType: "text/plain",
      requestBytes: 0, responseBytes: 2, startedAt: 1, ttfbMs: 1, durationMs: 2, failure: null,
    }))}\n`;
    const follow = (seed: (controller: ReadableStreamDefaultController<Uint8Array>) => void) => followCaptureHar({
      baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test", replace: true,
      fetchImpl: async (input) => String(input).includes("/network-capture.ndjson")
        ? new Response(new ReadableStream<Uint8Array>({ start: seed }))
        : new Response(capturingStream()),
    });
    try {
      // HTTP 200, one good entry, then the connection resets.
      await expect(follow((controller) => {
        controller.enqueue(new TextEncoder().encode(`${good}{"_captureId":"r2"`));
        controller.error(new Error("connection reset"));
      })).rejects.toThrow("connection reset");
      await expect(follow((controller) => {
        controller.enqueue(new TextEncoder().encode(`${good}{not json}\n${good}`));
        controller.close();
      })).rejects.toThrow("unreadable entry");
      expect(readFileSync(outPath, "utf8")).toBe(kept.har);
      expect(readFileSync(paths.eventsPath, "utf8")).toBe(kept.events);
      expect(readFileSync(paths.entriesPath, "utf8")).toBe(kept.entries);
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets a run that recorded no requests be run again without --force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-empty-rerun-"));
    const options = {
      baseUrl: "http://127.0.0.1:3999", device: "D", outPath: join(dir, "session.har"), token: "test",
      fetchImpl: withoutSession(async () => new Response(capturingStream())),
    };
    try {
      const first = await followCaptureHar(options);
      // The event log holds the run's meta frame, but no request finished.
      expect(readFileSync(first.eventsPath, "utf8")).toContain("capturing");
      expect((await followCaptureHar(options)).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps every file of a --force recording when one of them cannot be opened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-setup-"));
    const outPath = join(dir, "session.har");
    const paths = captureHarPaths(outPath);
    const kept = { har: '{"log":{"entries":["kept"]}}\n', events: "kept-event\n" };
    writeFileSync(outPath, kept.har);
    writeFileSync(paths.eventsPath, kept.events);
    // The entry log cannot be opened for writing.
    mkdirSync(paths.entriesPath);
    try {
      await expect(followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test", replace: true,
        fetchImpl: withoutSession(async () => new Response(capturingStream())),
      })).rejects.toThrow();
      expect(readFileSync(paths.eventsPath, "utf8")).toBe(kept.events);
      expect(readFileSync(outPath, "utf8")).toBe(kept.har);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes temp files a killed run left, and only this recording's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-temps-"));
    const outPath = join(dir, "session.har");
    const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const leftovers = [
      `session.har.${uuid}.har.tmp`,
      `session.entries.ndjson.${uuid}.compact.tmp`,
      // A staged seed holds decrypted requests; so do the files built from it.
      `session.entries.ndjson.${uuid}.seed.tmp`,
      `session.entries.ndjson.${uuid}.seed.tmp.${uuid}.compact.tmp`,
      `session.har.${uuid}.seed.tmp.${uuid}.har.tmp`,
      `session.network-capture.json.${uuid}.replace.tmp`,
    ];
    const others = [`other.har.${uuid}.har.tmp`, "session.har.notes.tmp"];
    for (const name of [...leftovers, ...others]) writeFileSync(join(dir, name), "x");
    const seed = `${JSON.stringify(toHarEntry({
      id: "r1", method: "GET", url: "https://a.test/", status: 200, mimeType: "text/plain",
      requestBytes: 0, responseBytes: 2, startedAt: 1, ttfbMs: 1, durationMs: 2, failure: null,
    }))}\n`;
    try {
      // Seeded, so the run's own staged seed sits among the leftovers while they are removed.
      const result = await followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test",
        fetchImpl: async (input) =>
          String(input).includes("/network-capture.ndjson") ? new Response(seed) : new Response(capturingStream()),
      });
      expect(result.size).toBe(1);
      for (const name of leftovers) expect(existsSync(join(dir, name))).toBe(false);
      for (const name of others) expect(existsSync(join(dir, name))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accumulates SSE frames and rewrites the HAR file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-"));
    const outPath = join(dir, "session.har");

    const frames = [
      `event: meta\n${CAPTURING}`,
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
      CAPTURING,
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
      if (String(input).includes("/network-capture/r1")) {
        // The output directory disappears under the writer, the way a cleaned temp dir would. The
        // body fetch runs once the recording has begun, so the writer is already in that directory.
        rmSync(dir, { recursive: true, force: true });
        return new Response("null", { status: 200 });
      }
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
    // The session holds r1-r3; the live store has already evicted r1 and replays r2-r3.
    const sessionEntries = [1, 2, 3].map((n) => JSON.stringify(toHarEntry(request(`r${n}`, n)))).join("\n") + "\n";
    // Chunks that end mid-line, the way a large body arrives.
    const seedChunks = [sessionEntries.slice(0, 50), sessionEntries.slice(50, 400), sessionEntries.slice(400)];
    const frames = [CAPTURING, ...[2, 3, 4].map((n) => `data: ${JSON.stringify({ type: "finished", request: request(`r${n}`, n) })}\n\n`)];
    const bodyFetches: string[] = [];
    try {
      const result = await followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test", flushIntervalMs: 50,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/network-capture.ndjson")) {
            return new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                for (const chunk of seedChunks) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
              },
            }));
          }
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

describe("followCaptureHar across a capture restart", () => {
  it("keeps a new session's requests whose ids repeat the old session's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-restart-"));
    const outPath = join(dir, "session.har");
    const request = (id: string, startedAt: number, url: string) => ({
      id, method: "GET", url, status: 200, mimeType: "text/plain",
      requestBytes: 0, responseBytes: 2, startedAt, ttfbMs: 1, durationMs: 2, failure: null,
    });
    const seed = `${JSON.stringify(toHarEntry(request("r1", 1, "https://a.test/old")))}\n`;
    // The old session's r1 replays, then a new session starts ("cleared", `starting`, `capturing`,
    // as the runtime sends them), and the new session's r1.
    const frames = [
      CAPTURING,
      `data: ${JSON.stringify({ type: "finished", request: request("r1", 1, "https://a.test/old") })}\n\n`,
      `data: ${JSON.stringify({ type: "cleared" })}\n\n`,
      metaFrame("starting"),
      CAPTURING,
      `data: ${JSON.stringify({ type: "finished", request: request("r1", 5, "https://a.test/new") })}\n\n`,
    ];
    try {
      await followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test", flushIntervalMs: 50,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/network-capture.ndjson")) return new Response(seed);
          if (url.includes("/network-capture/")) return new Response("null");
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
              controller.close();
            },
          }));
        },
      });
      const har = JSON.parse(readFileSync(outPath, "utf8")) as { log: { entries: { request: { url: string } }[] } };
      expect(har.log.entries.map((entry) => entry.request.url)).toEqual(["https://a.test/old", "https://a.test/new"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("followCaptureHar when capture restarts", () => {
  const request = (id: string, startedAt: number, url: string) => ({
    id, method: "GET", url, status: 200, mimeType: "text/plain",
    requestBytes: 0, responseBytes: 2, startedAt, ttfbMs: 1, durationMs: 2, failure: null,
  });
  const finishedFrame = (id: string, startedAt: number, url: string) =>
    `data: ${JSON.stringify({ type: "finished", request: request(id, startedAt, url) })}\n\n`;
  // Capture turned off and on, as the runtime sends it: `not-enabled`, then the new session's
  // "cleared", `starting`, and `capturing`.
  const restart = [metaFrame("not-enabled"), `data: ${JSON.stringify({ type: "cleared" })}\n\n`, metaFrame("starting"), CAPTURING];

  function follow(outPath: string, frames: string[], seed: string | null, events: string[] = []) {
    return followCaptureHar({
      baseUrl: "http://127.0.0.1:3999", device: "D", outPath, token: "test", flushIntervalMs: 50,
      onPause: () => void events.push("pause"),
      onResume: () => void events.push("resume"),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/network-capture.ndjson")) return seed === null ? new Response("", { status: 404 }) : new Response(seed);
        if (url.includes("/network-capture/")) return new Response("null");
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        }));
      },
    });
  }

  it("keeps recording and appends the new session's requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-append-"));
    const outPath = join(dir, "session.har");
    const events: string[] = [];
    try {
      const result = await follow(outPath, [
        CAPTURING,
        finishedFrame("r1", 1, "https://a.test/before"),
        ...restart,
        finishedFrame("r1", 5, "https://a.test/after"),
      ], null, events);
      expect(result.size).toBe(2);
      expect(events).toEqual(["pause", "resume"]);
      const har = JSON.parse(readFileSync(outPath, "utf8")) as { log: { entries: { request: { url: string } }[] } };
      expect(har.log.entries.map((entry) => entry.request.url)).toEqual(["https://a.test/before", "https://a.test/after"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps both sessions' requests once each when the restart lands while it seeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-restart-seed-"));
    const outPath = join(dir, "session.har");
    // Subscribed to the old session, but capture restarted before the seed was read: the seed is the
    // new session's r1, while the stream still holds the old session's r1, which shares its id.
    const seed = `${JSON.stringify(toHarEntry(request("r1", 5, "https://a.test/new")))}\n`;
    try {
      await follow(outPath, [
        CAPTURING,
        finishedFrame("r1", 1, "https://a.test/old"),
        ...restart,
        finishedFrame("r1", 5, "https://a.test/new"),
      ], seed);
      const har = JSON.parse(readFileSync(outPath, "utf8")) as { log: { entries: { request: { url: string } }[] } };
      expect(har.log.entries.map((entry) => entry.request.url)).toEqual(["https://a.test/old", "https://a.test/new"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails, without writing a HAR, when the stream closes before capture is on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-early-close-"));
    const outPath = join(dir, "session.har");
    try {
      await expect(follow(outPath, [metaFrame("starting")], null)).rejects.toThrow("closed before capture was on");
      expect(existsSync(outPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a new output folder for a session that already has requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-new-folder-"));
    const outPath = join(dir, "new-recordings", "morning.har");
    const seed = `${JSON.stringify(toHarEntry(request("r1", 1, "https://a.test/earlier")))}\n`;
    try {
      expect((await follow(outPath, [CAPTURING], seed)).size).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("followCaptureHar with a start time that is not a number", () => {
  it("records a seeded request once, and never looks its body up by id alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-nan-"));
    const request = {
      id: "r1", method: "GET", url: "https://a.test/", status: 200, mimeType: "text/plain",
      requestBytes: 0, responseBytes: 2, startedAt: Number.NaN, ttfbMs: 1, durationMs: 2, failure: null,
    };
    // JSON carries NaN as null, both in the seed and on the stream.
    const seed = `${JSON.stringify(toHarEntry(request))}\n`;
    const frames = [CAPTURING, `data: ${JSON.stringify({ type: "finished", request })}\n\n`, `data: ${JSON.stringify({ type: "finished", request: { ...request, id: "r2" } })}\n\n`];
    const bodyUrls: string[] = [];
    try {
      const result = await followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath: join(dir, "a.har"), token: "test", flushIntervalMs: 50,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/network-capture.ndjson")) return new Response(seed);
          if (url.includes("/network-capture/")) {
            bodyUrls.push(url);
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
      expect(result.size).toBe(2);
      // An id alone could name a newer session's request, so no body is fetched for it.
      expect(bodyUrls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("followCaptureHar with a body whose lock cannot be released", () => {
  it("still records, as a finished fetch body under Bun can throw from releaseLock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-release-"));
    const seed = `${JSON.stringify(toHarEntry({
      id: "r1", method: "GET", url: "https://a.test/", status: 200, mimeType: "text/plain",
      requestBytes: 0, responseBytes: 2, startedAt: 1, ttfbMs: 1, durationMs: 2, failure: null,
    }))}\n`;
    // Reads like a stream, then throws where Bun's finished fetch body does.
    const throwingBody = (text: string) => {
      let sent = false;
      return {
        getReader: () => ({
          read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: new TextEncoder().encode(text) })),
          releaseLock: () => { throw new TypeError("undefined is not a function"); },
          cancel: async () => {},
        }),
      };
    };
    try {
      const result = await followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath: join(dir, "a.har"), token: "test",
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/network-capture.ndjson")) return { ok: true, status: 200, body: throwingBody(seed) } as unknown as Response;
          return { ok: true, status: 200, body: throwingBody(CAPTURING) } as unknown as Response;
        },
      });
      expect(result.size).toBe(1);
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
        controller.enqueue(new TextEncoder().encode(CAPTURING));
        controller.enqueue(new TextEncoder().encode('data: {"type":"finished","request":{"id":"r1","method":"GET","url":"https://a.test/","status":200,"mimeType":"text/plain","requestBytes":0,"responseBytes":2,"startedAt":1,"ttfbMs":1,"durationMs":2,"failure":null}}\n\n'));
        controller.close();
      },
    });
    try {
      await followCaptureHar({
        baseUrl: "http://127.0.0.1:3200/.sim", device: "D", outPath: join(dir, "session.har"), token: "test",
        fetchImpl: async (input) => {
          requested.push(String(input));
          if (String(input).includes("/network-capture.ndjson")) return new Response("", { status: 404 });
          return String(input).includes("/network-capture/") ? new Response("null") : new Response(stream);
        },
      });
      expect(requested).toEqual([
        "http://127.0.0.1:3200/.sim/network-capture?device=D",
        "http://127.0.0.1:3200/.sim/network-capture.ndjson?device=D",
        "http://127.0.0.1:3200/.sim/network-capture/r1?device=D&startedAt=1",
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
            controller.enqueue(new TextEncoder().encode(CAPTURING));
            controller.enqueue(new TextEncoder().encode(finished("r1")));
            await release;
            controller.close();
          },
        }));
      }),
    });
  }

  it("refuses a second live recording on the same --events, and allows it once the first stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-shared-events-"));
    const events = join(dir, "shared.json");
    const followWith = (outPath: string, gate: Promise<void>) => followCaptureHar({
      baseUrl: "http://127.0.0.1:3999", device: "D", outPath, eventsPath: events, token: "test", flushIntervalMs: 50,
      fetchImpl: withoutSession(async (input) => {
        if (String(input).includes("/network-capture/")) return new Response("null");
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(CAPTURING));
            controller.enqueue(new TextEncoder().encode(finished("r1")));
            await gate;
            controller.close();
          },
        }));
      }),
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    try {
      const first = followWith(join(dir, "a.har"), gate);
      await Bun.sleep(100);
      await expect(followWith(join(dir, "b.har"), Promise.resolve())).rejects.toThrow("Another recording holds");
      expect(readFileSync(events, "utf8")).toContain("r1");
      release();
      expect((await first).size).toBe(1);
      // Stopped: the event log is free again.
      expect((await followWith(join(dir, "b.har"), Promise.resolve())).size).toBe(1);
    } finally {
      release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records with an event log named like the HAR's stem", async () => {
    // `--events morning` beside `morning.har`: the event log's claim must not take the HAR's owner file.
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-events-stem-"));
    try {
      const result = await followCaptureHar({
        baseUrl: "http://127.0.0.1:3999", device: "D", outPath: join(dir, "morning.har"), eventsPath: join(dir, "morning"), token: "test",
        fetchImpl: withoutSession(async () => new Response(capturingStream())),
      });
      expect(result.size).toBe(0);
      expect(readFileSync(join(dir, "morning"), "utf8")).toContain("capturing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
