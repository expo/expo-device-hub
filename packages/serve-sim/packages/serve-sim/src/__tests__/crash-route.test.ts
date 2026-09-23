import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";
import { handleCrashReportRequest, handleCrashesRequest } from "../middleware";
import { handleCrashesRequestAfter } from "../crash/routes";
import { inProcessServeSimState } from "../state";
import { createCrashRuntime } from "../crash/runtime";
import type { CrashRuntime } from "../crash/runtime";
import type { LogBufferCache } from "../log-buffer";

const UDID = "CD26E7DF-F2CE-4DCB-B950-2F062DE3FBB3";

function bundleRoot(udid: string): string {
  return (
    `/Users/USER/Library/Developer/CoreSimulator/Devices/${udid}` +
    "/data/Containers/Bundle/Application/9E92F5F8/Demo.app"
  );
}

function ips(udid = UDID, symbol = "AppDelegate.boot()"): string {
  const root = bundleRoot(udid);
  const header = {
    app_name: "Demo",
    platform: 7,
    bundleID: "com.example.demo",
    bug_type: "309",
    incident_id: "INC-1",
  };
  const body = {
    procName: "Demo",
    procPath: `${root}/Demo`,
    pid: 42,
    captureTime: "2026-08-04 23:14:07.8433 -0700",
    exception: { type: "EXC_CRASH", signal: "SIGABRT" },
    termination: { indicator: "Abort trap: 6" },
    faultingThread: 0,
    usedImages: [{ name: "Demo", path: `${root}/Demo` }],
    threads: [{ triggered: true, frames: [{ imageIndex: 0, imageOffset: 1, symbol }] }],
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(body)}\n`;
}

/** A real report for this crash that also names the file it was read from. */
const ipsAt = (path: string): string => ips().replace('"app_name":"Demo"', `"app_name":"Demo","source":"${path}"`);

type FakeRes = ServerResponse & {
  statusCode_: number;
  headers_: Record<string, string>;
  body_: string;
  destroyStream: () => void;
};

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { headers }) as unknown as IncomingMessage;
}

function fakeRes(): FakeRes {
  const res = {
    statusCode_: 0,
    headers_: {} as Record<string, string>,
    body_: "",
    destroyed: false,
    writableEnded: false,
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
      res.writableEnded = true;
      return res;
    },
    destroyStream() {
      res.destroyed = true;
    },
  };
  return res as unknown as FakeRes;
}

const state = inProcessServeSimState(UDID, 4000);

/** A runtime with one crash already collected. Every fs call is faked. */
async function runtimeWithCrash(): Promise<CrashRuntime> {
  let emit: (eventType: string, filename: string | null) => void = () => {};
  const runtime = createCrashRuntime({
    reportsDir: "/reports",
    ensureDir: () => {},
    watchDir: (_dir, listener) => {
      emit = listener;
      return { close: () => {} };
    },
    readReport: async () => ips(),
    readDir: async () => [],
    statFile: async () => ({ mtimeMs: 0, ino: 1 }),
    onError: () => {},
  });
  runtime.start();
  emit("rename", "Demo-1.ips");
  await new Promise((resolve) => setTimeout(resolve, 0));
  return runtime;
}

function missingFile(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
}

/** Two crashes that share a signature, so they collapse into one record. */
async function runtimeWithRepeat(): Promise<CrashRuntime> {
  let emit: (eventType: string, filename: string | null) => void = () => {};
  const runtime = createCrashRuntime({
    reportsDir: "/reports",
    ensureDir: () => {},
    watchDir: (_dir, listener) => {
      emit = listener;
      return { close: () => {} };
    },
    readReport: async () => ips(),
    readDir: async () => [],
    statFile: async () => ({ mtimeMs: 0, ino: 1 }),
    onError: () => {},
  });
  runtime.start();
  emit("rename", "Demo-1.ips");
  await new Promise((resolve) => setTimeout(resolve, 0));
  emit("rename", "Demo-2.ips");
  await new Promise((resolve) => setTimeout(resolve, 0));
  return runtime;
}

describe("handleCrashesRequest", () => {
  test("404s when there is no device", () => {
    const res = fakeRes();
    handleCrashesRequest(fakeReq(), res, null);
    expect(res.statusCode_).toBe(404);
    expect(JSON.parse(res.body_).error).toContain("No serve-sim device");
  });

  test("returns JSON with the crash list and collection meta", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    handleCrashesRequest(fakeReq(), res, state, runtime);

    expect(res.statusCode_).toBe(200);
    expect(res.headers_["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(res.body_);
    expect(payload.meta.status).toBe("watching");
    expect(payload.meta.reportDelaySeconds).toBeGreaterThan(0);
    expect(payload.crashes).toHaveLength(1);
    expect(payload.crashes[0].culpritFrame).toBe("Demo AppDelegate.boot()");
    expect(payload.crashes[0].logTail).toBeUndefined();
    expect(payload.crashes[0].logTailLines).toBe(0);
  });

  test("explains itself when collection is unavailable, with an empty list", () => {
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {
        throw new Error("EPERM");
      },
      watchDir: () => ({ close: () => {} }),
      onError: () => {},
    });
    runtime.start();

    const res = fakeRes();
    handleCrashesRequest(fakeReq(), res, state, runtime);

    const payload = JSON.parse(res.body_);
    expect(payload.crashes).toEqual([]);
    expect(payload.meta.status).toBe("unavailable");
    expect(payload.meta.statusError).toContain("not being collected");
  });

  test("streams SSE with meta before the authoritative list", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    handleCrashesRequest(fakeReq({ accept: "text/event-stream" }), res, state, runtime);

    expect(res.headers_["Content-Type"]).toBe("text/event-stream");
    const metaAt = res.body_.indexOf('"type":"meta"');
    const listAt = res.body_.indexOf('"type":"list"');
    expect(metaAt).toBeGreaterThanOrEqual(0);
    expect(listAt).toBeGreaterThan(metaAt);

    const frame = JSON.parse(res.body_.slice(listAt - 1, res.body_.indexOf("\n\n", listAt))) as {
      crashes: { id: string }[];
    };
    expect(frame.crashes.map((crash) => crash.id)).toEqual(["INC-1"]);
  });

  test("keeps a device tail reader for the life of the stream", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    const req = fakeReq({ accept: "text/event-stream" });
    let readers = 0;
    const buffers = {
      ensure: () => {
        readers += 1;
        return {
          subscribeBatch: () => () => {
            readers -= 1;
          },
        };
      },
    } as unknown as LogBufferCache;

    handleCrashesRequest(req, res, state, runtime, buffers);
    expect(readers).toBe(1);

    req.emit("close");
    expect(readers).toBe(0);
  });

  function countingBuffers() {
    let readers = 0;
    const buffers = {
      ensure: () => {
        readers += 1;
        return {
          subscribeBatch: () => () => {
            readers -= 1;
          },
        };
      },
    } as unknown as LogBufferCache;
    return { buffers, readers: () => readers };
  }

  test("holds the device tail while the crash watcher starts, then hands it to the stream", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    const req = fakeReq({ accept: "text/event-stream" });
    const { buffers, readers } = countingBuffers();
    const started = Promise.withResolvers<void>();

    const serving = handleCrashesRequestAfter(() => started.promise, req, res, state, runtime, buffers);
    expect(readers()).toBe(1);
    started.resolve();
    await serving;
    expect(readers()).toBe(1);

    req.emit("close");
    expect(readers()).toBe(0);
  });

  test("does not hold the tail for a JSON request while the watcher starts", async () => {
    const runtime = await runtimeWithCrash();
    const { buffers, readers } = countingBuffers();
    const started = Promise.withResolvers<void>();

    const serving = handleCrashesRequestAfter(() => started.promise, fakeReq(), fakeRes(), state, runtime, buffers);
    expect(readers()).toBe(0);
    started.resolve();
    await serving;
    expect(readers()).toBe(0);
  });

  test("does not open a stream for a client that already went away", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    res.destroyStream();

    handleCrashesRequest(fakeReq({ accept: "text/event-stream" }), res, state, runtime);

    expect(res.statusCode_).toBe(0);
    expect(res.body_).toBe("");
  });
});

describe("handleCrashReportRequest", () => {
  test("404s for an unknown id, and blames the id not the device", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "nope", null, runtime);
    expect(res.statusCode_).toBe(404);
    expect(JSON.parse(res.body_).error).toContain("No crash with id nope");
  });

  test("404s when there is no device, and says so", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, null, "INC-1", null, runtime);
    expect(res.statusCode_).toBe(404);
    expect(JSON.parse(res.body_).error).toContain("No serve-sim device");
  });

  test("returns the record and the full report", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async () => ips());

    expect(res.statusCode_).toBe(200);
    const payload = JSON.parse(res.body_);
    expect(payload.record.id).toBe("INC-1");
    expect(payload.record.logTailLines).toBe(0);
    expect(payload.occurrence.logTail).toEqual([]);
    expect(payload.report).toBe(ips());
    expect(payload.reportError).toBeNull();
  });

  test("checks an occurrence without an incident id by pid and capture time", async () => {
    const incidentless = ips().replace(',"incident_id":"INC-1"', "");
    let emit: (eventType: string, filename: string | null) => void = () => {};
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {},
      watchDir: (_dir, listener) => {
        emit = listener;
        return { close: () => {} };
      },
      readReport: async () => incidentless,
      readDir: async () => [],
      statFile: async () => ({ mtimeMs: 0, ino: 1 }),
      onError: () => {},
    });
    runtime.start();
    emit("rename", "Demo-1.ips");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const id = runtime.listFor(UDID)[0]!.id;

    const same = fakeRes();
    await handleCrashReportRequest(fakeReq(), same, state, id, null, runtime, async () => incidentless);
    expect(JSON.parse(same.body_).report).toBe(incidentless);

    const other = fakeRes();
    const newer = incidentless.replace('"pid":42', '"pid":43');
    await handleCrashReportRequest(fakeReq(), other, state, id, null, runtime, async () => newer);
    expect(JSON.parse(other.body_).report).toBeNull();
    expect(JSON.parse(other.body_).reportError).toContain("no longer holds this crash");
  });

  test("does not serve a report whose header matches but whose body is cut off", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    const cutOff = `${ips().split("\n")[0]}\n{ "pid":`;
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async () => cutOff);

    const payload = JSON.parse(res.body_);
    expect(payload.report).toBeNull();
    expect(payload.reportError).toContain("no longer holds this crash");
  });

  test("does not serve a file at this occurrence's path that no longer parses", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async () => '{"app_name":"De');

    const payload = JSON.parse(res.body_);
    expect(payload.report).toBeNull();
    expect(payload.reportError).toContain("no longer holds this crash");
  });

  test("returns the selected occurrence's own parsed stack", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async () => ips());

    const payload = JSON.parse(res.body_);
    expect(payload.occurrence.frames.map((frame: { symbol: string }) => frame.symbol)).toEqual(["AppDelegate.boot()"]);
  });

  test("does not show a newer report that took over this occurrence's path", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    const newer = ips().replace('"INC-1"', '"INC-2"');
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async () => newer);

    const payload = JSON.parse(res.body_);
    expect(payload.report).toBeNull();
    expect(payload.reportError).toContain("no longer holds this crash");
  });

  test("serves the newest occurrence when none is asked for", async () => {
    const runtime = await runtimeWithRepeat();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async (path) => ipsAt(path));

    const payload = JSON.parse(res.body_);
    expect(payload.record.count).toBe(2);
    expect(payload.occurrence).toMatchObject({ index: 1, total: 2 });
    expect(payload.report).toContain('"source":"/reports/Demo-2.ips"');
  });

  test("serves an older occurrence on request", async () => {
    const runtime = await runtimeWithRepeat();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", "0", runtime, async (path) => ipsAt(path));

    const payload = JSON.parse(res.body_);
    expect(payload.occurrence).toMatchObject({ index: 0, total: 2 });
    expect(payload.report).toContain('"source":"/reports/Demo-1.ips"');
  });

  test("treats an empty occurrence param as the newest occurrence", async () => {
    const runtime = await runtimeWithRepeat();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", "", runtime, async (path) => ipsAt(path));

    expect(res.statusCode_).toBe(200);
    expect(JSON.parse(res.body_).occurrence).toMatchObject({ index: 1, total: 2 });
  });

  test("rejects an occurrence outside the retained window", async () => {
    const runtime = await runtimeWithRepeat();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", "7", runtime);

    expect(res.statusCode_).toBe(400);
    expect(JSON.parse(res.body_).error).toContain("0-1");
  });

  test("reads a report that macOS has moved into Retired/", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    const reads: string[] = [];
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async (path) => {
      reads.push(path);
      if (!path.includes("/Retired/")) throw missingFile();
      return ipsAt(path);
    });

    const payload = JSON.parse(res.body_);
    expect(payload.report).toContain('"source":"/reports/Retired/Demo-1.ips"');
    expect(payload.reportError).toBeNull();
    expect(reads).toEqual(["/reports/Demo-1.ips", "/reports/Retired/Demo-1.ips"]);
  });

  test("keeps the summary and explains a report macOS has deleted", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async () => {
      throw missingFile();
    });

    expect(res.statusCode_).toBe(200);
    const payload = JSON.parse(res.body_);
    expect(payload.record.id).toBe("INC-1");
    expect(payload.report).toBeNull();
    expect(payload.reportError).toContain("deleted");
  });

  test("reports why a report in Retired/ could not be read", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async (path) => {
      if (!path.includes("/Retired/")) throw missingFile();
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });

    const payload = JSON.parse(res.body_);
    expect(payload.report).toBeNull();
    expect(payload.reportError).toContain("EACCES");
    expect(payload.reportError).toContain("/reports/Retired/Demo-1.ips");
    expect(payload.reportError).not.toContain("deleted");
  });

  test("does not look in Retired/ for a report it cannot read", async () => {
    const runtime = await runtimeWithCrash();
    const res = fakeRes();
    const reads: string[] = [];
    await handleCrashReportRequest(fakeReq(), res, state, "INC-1", null, runtime, async (path) => {
      reads.push(path);
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });

    const payload = JSON.parse(res.body_);
    expect(reads).toEqual(["/reports/Demo-1.ips"]);
    expect(payload.reportError).toContain("EACCES");
  });
});
