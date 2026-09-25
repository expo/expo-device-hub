import { capabilityHarness } from "./capability-harness";
import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";

import { createCaptureRuntime } from "../runtime";
import { type CaptureProxy } from "../mitm-engine";
import { type CaptureMeta } from "../store";
import {
  handleCaptureBodyRequest,
  handleCaptureHarRequest,
  handleNetworkCaptureRequest,
} from "../../middleware";
import { inProcessServeSimState } from "../../state";

/**
 * Unit tests for the `/network-capture` routes, driven with a fake req/res and a runtime whose proxy,
 * trust install, and injection are stubbed — so they run without opening sockets or touching a simulator.
 */

function createFakeReq(): { req: IncomingMessage; close: () => void } {
  const req = Object.assign(new EventEmitter(), { headers: {} });
  return { req: req as unknown as IncomingMessage, close: () => req.emit("close") };
}

/** A real Writable, because the HAR route pipes a file stream into the response. */
function createFakeRes(): { res: ServerResponse; writes: string[]; status: () => number } {
  const writes: string[] = [];
  let statusCode = 0;
  const res = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      writes.push(chunk.toString());
      done();
    },
  });
  Object.assign(res, {
    writeHead(status: number) {
      statusCode = status;
      return res;
    },
  });
  return { res: res as unknown as ServerResponse, writes, status: () => statusCode };
}

/** A runtime that reports a fixed proxy address and touches nothing on the device. */
function stubRuntime() {
  const closed: string[] = [];
  const runtime = createCaptureRuntime({
    startProxy: async () =>
      ({
        address: "127.0.0.1:9999",
        portFile: "/tmp/fake-confdir/proxy-port",
        caPem: async () => "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
        close: async () => void closed.push("x"),
      }) as CaptureProxy,
    trustCa: async () => {},
    dylib: () => "/fake/libSimNetProxy.dylib",
    configure: capabilityHarness(),
    writeDiskArtifacts: false,
    isInjected: async () => true,
  });
  return { runtime, closed };
}

const dataFrames = (writes: string[]): string[] => writes.filter((w) => w.startsWith("data:"));
const metaFrom = (writes: string[]): CaptureMeta => {
  for (const frame of dataFrames(writes)) {
    const parsed = JSON.parse(frame.slice("data:".length).trim()) as { type?: string; meta?: CaptureMeta };
    if (parsed.type === "meta" && parsed.meta) return parsed.meta;
  }
  throw new Error("missing meta frame");
};

describe("handleNetworkCaptureRequest", () => {
  test("responds 404 when no device is selected", () => {
    const { runtime } = stubRuntime();
    const { req } = createFakeReq();
    const { res, status } = createFakeRes();

    handleNetworkCaptureRequest(req, res, null, runtime);

    expect(status()).toBe(404);
  });

  test("writes a meta frame carrying the proxy address and capturing attachment", async () => {
    const { runtime } = stubRuntime();
    await runtime.enableForDevice("UDID-1");
    const { req, close } = createFakeReq();
    const { res, writes } = createFakeRes();
    const state = inProcessServeSimState("UDID-1", 4000);

    handleNetworkCaptureRequest(req, res, state, runtime);

    const meta = metaFrom(writes);
    expect(meta.udid).toBe("UDID-1");
    expect(meta.proxyAddress).toBe("127.0.0.1:9999");
    expect(meta.attachment).toBe("capturing");

    close();
  });

  test("reports capture off without inventing a failure", () => {
    const { runtime } = stubRuntime();
    const { req, close } = createFakeReq();
    const { res, writes } = createFakeRes();
    const state = inProcessServeSimState("UDID-NOT-ENABLED", 4000);

    handleNetworkCaptureRequest(req, res, state, runtime);

    // The metadata distinguishes capture being off from an idle capture stream.
    const meta = metaFrom(writes);
    expect(meta.attachment).toBe("not-enabled");
    expect(meta.attachError).toBeNull();
    expect(dataFrames(writes)).toHaveLength(1);

    close();
  });

  test("streams captured requests to the subscriber as started/finished frames", async () => {
    const { runtime } = stubRuntime();
    await runtime.enableForDevice("UDID-1");
    const { req, close } = createFakeReq();
    const { res, writes } = createFakeRes();
    const state = inProcessServeSimState("UDID-1", 4000);

    handleNetworkCaptureRequest(req, res, state, runtime);

    const store = runtime.storeFor("UDID-1");
    if (!store) throw new Error("expected capture store");
    const id = store.start("GET", "https://example.com/a");
    store.update(id, { status: 200, durationMs: 5 }, /* settled */ true);

    const frames = dataFrames(writes).map((w) => JSON.parse(w.slice("data:".length).trim()));
    expect(frames.map((f) => f.type)).toEqual(["meta", "started", "finished"]);
    expect(frames[0].initial).toBe(true);
    expect(frames[2].request.url).toBe("https://example.com/a");
    expect(frames[2].request.status).toBe(200);

    close();
  });

  test("replays requests recorded before the viewer arrived, including from before it opened", async () => {
    const { runtime } = stubRuntime();
    await runtime.enableForDevice("UDID-1");
    const state = inProcessServeSimState("UDID-1", 4000);

    // Recorded with nobody watching at all — the case boot-time capture exists for.
    const store = runtime.storeFor("UDID-1");
    if (!store) throw new Error("expected capture store");
    store.start("GET", "https://example.com/startup");

    const viewer = createFakeReq();
    const viewerRes = createFakeRes();
    handleNetworkCaptureRequest(viewer.req, viewerRes.res, state, runtime);

    const urls = dataFrames(viewerRes.writes)
      .map((w) => JSON.parse(w.slice("data:".length).trim()))
      .map((f) => f.request?.url);
    expect(urls).toContain("https://example.com/startup");

    viewer.close();
  });

  test("replays in-flight rows as started, not finished", async () => {
    const { runtime } = stubRuntime();
    await runtime.enableForDevice("UDID-1");
    const state = inProcessServeSimState("UDID-1", 4000);
    const store = runtime.storeFor("UDID-1")!;
    store.start("GET", "https://example.com/pending");
    const done = store.start("GET", "https://example.com/done");
    store.update(done, { status: 200, durationMs: 1 }, /* settled */ true);

    const viewer = createFakeReq();
    const viewerRes = createFakeRes();
    handleNetworkCaptureRequest(viewer.req, viewerRes.res, state, runtime);

    const frames = dataFrames(viewerRes.writes).map((w) => JSON.parse(w.slice("data:".length).trim()));
    const byUrl = Object.fromEntries(
      frames.filter((f) => f.request).map((f) => [f.request.url, f.type]),
    );
    expect(byUrl["https://example.com/pending"]).toBe("started");
    expect(byUrl["https://example.com/done"]).toBe("finished");

    viewer.close();
  });

  test("keeps the device capturing after every viewer closes", async () => {
    const { runtime, closed } = stubRuntime();
    await runtime.enableForDevice("UDID-1");
    const state = inProcessServeSimState("UDID-1", 4000);
    const a = createFakeReq();
    const b = createFakeReq();

    handleNetworkCaptureRequest(a.req, createFakeRes().res, state, runtime);
    handleNetworkCaptureRequest(b.req, createFakeRes().res, state, runtime);

    a.close();
    b.close();
    await Bun.sleep(10);

    // Capture belongs to the booted device. A closed panel must not stop it, or the developer would lose
    // the traffic they were about to look at — and the app would be left pointed at a dead port.
    expect(runtime.storeFor("UDID-1")).not.toBeNull();
    expect(runtime.metaFor("UDID-1").attachment).toBe("capturing");
    expect(closed).toHaveLength(0);
  });
});

describe("handleCaptureBodyRequest", () => {
  test("returns the stored headers and bodies for a captured request", async () => {
    const { runtime } = stubRuntime();
    await runtime.enableForDevice("UDID-1");
    const state = inProcessServeSimState("UDID-1", 4000);

    const store = runtime.storeFor("UDID-1");
    if (!store) throw new Error("expected capture store");
    const id = store.start("POST", "https://example.com/upload");
    store.setBody(id, {
      requestHeaders: { "content-type": "application/json" },
      responseHeaders: { "content-type": "application/json" },
      requestBody: '{"a":1}',
      responseBody: '{"ok":true}',
      requestTruncated: false,
      responseTruncated: true,
      requestBinary: false,
      responseBinary: false,
    });

    const { req } = createFakeReq();
    const { res, writes, status } = createFakeRes();
    handleCaptureBodyRequest(req, res, state, id, runtime);

    expect(status()).toBe(200);
    const body = JSON.parse(writes.join(""));
    expect(body.requestBody).toBe('{"a":1}');
    expect(body.responseBody).toBe('{"ok":true}');
    expect(body.responseTruncated).toBe(true);
  });

  test("404s for an unknown id, a device not capturing, and no device at all", async () => {
    const { runtime } = stubRuntime();
    const state = inProcessServeSimState("UDID-1", 4000);

    const notCapturing = createFakeRes();
    handleCaptureBodyRequest(createFakeReq().req, notCapturing.res, state, "r1", runtime);
    expect(notCapturing.status()).toBe(404);

    const noDevice = createFakeRes();
    handleCaptureBodyRequest(createFakeReq().req, noDevice.res, null, "r1", runtime);
    expect(noDevice.status()).toBe(404);

    await runtime.enableForDevice("UDID-1");
    const unknown = createFakeRes();
    handleCaptureBodyRequest(createFakeReq().req, unknown.res, state, "r404", runtime);
    expect(unknown.status()).toBe(404);
  });
});

describe("capture exports for another server's device", () => {
  test("404 even when this process captures a device with the same udid", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-owner-"));
    const runtime = createCaptureRuntime({
      writeDiskArtifacts: true,
      captureDirFor: () => dir,
      flushIntervalMs: 60_000,
      startProxy: async () =>
        ({
          address: "127.0.0.1:9999",
          portFile: "/tmp/fake-confdir/proxy-port",
          caPem: async () => "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
          close: async () => {},
        }) as CaptureProxy,
      trustCa: async () => {},
      dylib: () => "/fake/libSimNetProxy.dylib",
      configure: capabilityHarness(),
    });
    try {
      await runtime.enableForDevice("UDID-1");
      const store = runtime.storeFor("UDID-1");
      if (!store) throw new Error("expected capture store");
      const id = store.start("GET", "https://example.com/private");
      store.setBody(id, {
        requestHeaders: {},
        responseHeaders: {},
        requestBody: null,
        responseBody: "secret",
        requestTruncated: false,
        responseTruncated: false,
        requestBinary: false,
        responseBinary: false,
      });
      store.update(id, { status: 200, durationMs: 1 }, true);
      // The state file for this udid was written by a different serve-sim process.
      const foreign = { ...inProcessServeSimState("UDID-1", 4000), pid: process.pid + 1 };

      const body = createFakeRes();
      handleCaptureBodyRequest(createFakeReq().req, body.res, foreign, id, runtime);
      expect(body.status()).toBe(404);
      expect(body.writes.join("")).not.toContain("secret");

      const har = createFakeRes();
      await handleCaptureHarRequest(createFakeReq().req, har.res, foreign, runtime);
      expect(har.status()).toBe(404);
      expect(har.writes.join("")).not.toContain("example.com/private");
    } finally {
      await runtime.disableForDevice("UDID-1");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("handleCaptureHarRequest", () => {
  test("returns the session capture.har from disk", async () => {
    const { appendFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-route-"));
    const closed: string[] = [];
    const runtime = createCaptureRuntime({
      writeDiskArtifacts: true,
      captureDirFor: () => dir,
      flushIntervalMs: 60_000,
      startProxy: async () =>
        ({
          address: "127.0.0.1:9999",
          portFile: "/tmp/fake-confdir/proxy-port",
          caPem: async () => "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
          close: async () => void closed.push("x"),
        }) as CaptureProxy,
      trustCa: async () => {},
      dylib: () => "/fake/libSimNetProxy.dylib",
      configure: capabilityHarness(),
    });

    try {
      await runtime.enableForDevice("UDID-1");
      const state = inProcessServeSimState("UDID-1", 4000);
      const store = runtime.storeFor("UDID-1");
      if (!store) throw new Error("expected capture store");
      const id = store.start("GET", "https://example.com/har");
      store.update(id, { status: 200, durationMs: 4 }, true);
      const harPath = await runtime.flushHarPathFor("UDID-1");
      if (!harPath) throw new Error("expected capture HAR");
      appendFileSync(harPath, " ".repeat(200_000));

      const { req } = createFakeReq();
      const { res, writes, status } = createFakeRes();
      await handleCaptureHarRequest(req, res, state, runtime);

      expect(status()).toBe(200);
      const har = JSON.parse(writes.join(""));
      expect(har.log.version).toBe("1.2");
      expect(har.log.entries).toHaveLength(1);
      expect(har.log.entries[0].request.url).toBe("https://example.com/har");
      expect(writes.length).toBeGreaterThan(1);
    } finally {
      await runtime.disableForDevice("UDID-1");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("404s when nothing is capturing", async () => {
    const { runtime } = stubRuntime();
    const { res, status } = createFakeRes();
    await handleCaptureHarRequest(
      createFakeReq().req,
      res,
      inProcessServeSimState("UDID-1", 4000),
      runtime,
    );
    expect(status()).toBe(404);
  });
});
