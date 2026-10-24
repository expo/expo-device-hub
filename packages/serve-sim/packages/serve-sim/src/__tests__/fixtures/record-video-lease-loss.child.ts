import { mock } from "bun:test";
import * as cp from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

const mode = process.env.LEASE_LOSS_CASE;
const fetchOriginal = globalThis.fetch;
if (mode === "definitive-body-error") {
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await fetchOriginal(...args);
    if (response.status !== 409) return response;
    await response.body?.cancel();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("Lost response body transport"));
        },
      }),
      { status: 409 },
    );
  }) as typeof fetch;
}
const directory = mkdtempSync(join(tmpdir(), "record-video-lease-loss-"));
const udid = "owned-lease-loss-test";
process.env.SERVE_SIM_STATE_DIR = directory;
mock.module("child_process", () => ({
  ...cp,
  execSync: (command: string) => {
    if (command === "xcrun simctl list devices booted -j")
      return JSON.stringify({ devices: { test: [{ udid, state: "Booted" }] } });
    throw new Error(`Unexpected command: ${command}`);
  },
}));
const now = Date.now;
const timeout = globalThis.setTimeout;
const interval = globalThis.setInterval;
const kill = process.kill;
const started = now();
let stopCaused = false;
let deleted = false;
let deletedBeforeStopCause = false;
let stopTimerWaitMs = 0;
Date.now = () => started + (now() - started) * 100;
// Real I/O and scheduler delay also run 100 times "faster" on this clock, so a stop is measured by
// the client timeouts it starts after its cause and waits for before the DELETE, never by Date.now.
globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const afterStopCause = stopCaused && !deleted;
  return timeout(
    () => {
      if (afterStopCause && !deleted) stopTimerWaitMs += ms ?? 0;
      fn(...args);
    },
    ms === undefined ? ms : ms / 100,
  );
}) as typeof setTimeout;
// An interval tick between the stop cause and the DELETE does not run, so a stop that waits for the
// next heartbeat never sends its DELETE and the test fails, instead of counting zero timeouts.
globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
  interval(
    () => {
      if (stopCaused && !deleted) return;
      fn(...args);
    },
    ms === undefined ? ms : ms / 100,
  )) as typeof setInterval;
const later = (fn: () => void, ms: number) => timeout(fn, ms / 100);
const stop = () => {
  stopCaused = true;
  process.emit("SIGINT");
};
const ownerPid = 777000000;
let hostExited = false;
process.kill = ((pid: number, signal?: string | number) => {
  if (pid === ownerPid && (signal === 0 || signal === undefined)) {
    if (hostExited) throw Object.assign(new Error("host exited"), { code: "ESRCH" });
    return true;
  }
  return kill(pid, signal as NodeJS.Signals);
}) as typeof process.kill;
const output = join(directory, "output");
const manifest = join(output, "session.json");
let puts = 0;
let deletes = 0;
let id = "";
let lease: ReturnType<typeof setTimeout> | undefined;
const save = () => {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    manifest,
    JSON.stringify(
      mode?.endsWith("failed")
        ? { status: "failed", error: "Hardware encoder failed", recording: "recording.mp4" }
        : {},
    ),
  );
};
const renew = () => {
  if (lease) clearTimeout(lease);
  lease = later(
    () => {
      if (mode === "stop-missed-lease") later(save, 90_000);
      else save();
    },
    mode === "stop-missed-lease" || mode === "stop-rejected" ? 180_000 : 20_000,
  );
};
const server = createServer(async (req, res) => {
  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    id = JSON.parse(body).recordingId;
    renew();
    res.end("{}");
    return;
  }
  if (req.headers["x-recording-id"] !== id) throw new Error("wrong recording owner");
  if (req.method === "PUT") {
    puts++;
    if (puts === 1 || (mode === "transport" && puts === 2)) {
      // Stop while this heartbeat is in flight, before the client can start another one.
      if (mode === "stop-missed-lease" || mode === "stop-rejected") {
        renew();
        stop();
        res.end("{}");
        return;
      }
      if (mode?.startsWith("host-exit")) {
        save();
        hostExited = true;
        res.destroy();
        server.closeAllConnections();
        server.close();
        return;
      }
      if (mode === "signal" || mode === "pending-stop" || mode === "ambiguous-stop-failed") stop();
      if (mode === "pending-stop") return;
      if (mode === "transport") {
        res.destroy();
        return;
      }
      // A definitive status is the stop cause; no SIGINT follows, so a client that ignores it hangs.
      if (mode?.startsWith("definitive")) stopCaused = true;
      if (mode === "definitive-body-error" || mode === "definitive-body-pending") {
        res.writeHead(409);
        res.flushHeaders();
        if (mode === "definitive-body-error") res.end("heartbeat failure");
        return;
      }
      res.writeHead(mode === "definitive" ? 409 : 500);
      res.end("heartbeat failure");
      return;
    }
    renew();
    res.end("{}");
    // The recording survived the transient failure; only now does the user stop it.
    if ((mode === "transient" || mode === "transport") && !stopCaused) stop();
    return;
  }
  if (req.method === "DELETE") {
    deletes++;
    if (!deleted) deletedBeforeStopCause = !stopCaused;
    deleted = true;
    if (mode === "stop-missed-lease") {
      res.destroy();
      return;
    }
    if (mode === "stop-rejected") {
      res.writeHead(500);
      res.end("confirmed native stop error");
      return;
    }
    if (lease) clearTimeout(lease);
    save();
    if (mode === "ambiguous-stop-failed") {
      res.destroy();
      return;
    }
    res.end(JSON.stringify({ manifest }));
    return;
  }
  res.writeHead(405);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
writeFileSync(
  join(directory, `server-${udid}.json`),
  JSON.stringify({
    pid: ownerPid,
    port,
    device: udid,
    url: `http://127.0.0.1:${port}`,
    streamUrl: `http://127.0.0.1:${port}/stream.mjpeg`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  }),
);
process.argv = [process.execPath, "serve-sim", "record-video", "--udid", udid, "--output", output];
let error: unknown;
try {
  await import("../../index");
} catch (caught) {
  error = caught;
} finally {
  console.log(
    "LEASE_LOSS_RESULT " +
      JSON.stringify({
        puts,
        deletes,
        deletedBeforeStopCause,
        stopTimerWaitMs,
        error: error ? String(error) : null,
        saved: existsSync(manifest),
      }),
  );
  if (lease) clearTimeout(lease);
  server.closeAllConnections();
  server.close();
  globalThis.fetch = fetchOriginal;
  Date.now = now;
  globalThis.setTimeout = timeout;
  globalThis.setInterval = interval;
  process.kill = kill;
  rmSync(directory, { recursive: true, force: true });
}
