import { afterAll, beforeAll, expect, test } from "bun:test";
import WebSocket from "ws";
import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";
import { freePortAsync, recordState, useTempStateDir } from "./helpers";

const DEVICE = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const OTHER = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
const TOKEN = "single-device-test";
let server: PreviewServer;
let origin: string;
let stateDirectory: ReturnType<typeof useTempStateDir>;

beforeAll(async () => {
  stateDirectory = useTempStateDir();
  const port = await freePortAsync();
  origin = `http://127.0.0.1:${port}`;
  server = await servePreview({
    port,
    host: "127.0.0.1",
    middleware: simMiddleware({
      basePath: "/",
      singleDevice: DEVICE,
      execToken: TOKEN,
    }),
  });
});
afterAll(() => {
  server?.stop(true);
  stateDirectory.restore();
});

test("rejects query, helper-path, lifecycle, and WebKit escapes before device work", async () => {
  for (const path of [
    `/api?device=${OTHER}`,
    `/api?device=${DEVICE}&device=${OTHER}`,
    `/helper/${OTHER}/config`,
    `/helper/config?device=${OTHER}`,
    `/helper/stream.mjpeg?device=${DEVICE}&device=${OTHER}`,
    "/devtools",
    "/devtools/page/foreign",
    "/api?device=booted",
  ]) {
    const response = await fetch(origin + path);
    expect(response.status).toBe(403);
    await response.text();
  }
  for (const action of ["start", "shutdown"]) {
    const response = await fetch(`${origin}/grid/api/${action}`, {
      method: "POST",
      body: JSON.stringify({ udid: OTHER }),
    });
    expect(response.status).toBe(403);
    await response.text();
  }
});

test("lifecycle routes share body validation and refusal responses", async () => {
  for (const action of ["start", "shutdown"]) {
    for (const body of [
      "{",
      "null",
      "{}",
      JSON.stringify({ udid: "booted" }),
      JSON.stringify({ udid: [OTHER] }),
    ]) {
      const response = await fetch(`${origin}/grid/api/${action}`, { method: "POST", body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "Invalid or missing udid" });
    }
    const response = await fetch(`${origin}/grid/api/${action}`, {
      method: "POST",
      body: JSON.stringify({ udid: OTHER }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Device is outside this single-device session.",
    });
  }
});

test("allows observational requests with no target or the pinned target", async () => {
  for (const query of ["", `?device=${DEVICE.toLowerCase()}`]) {
    const response = await fetch(`${origin}/api/event-log${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [] });
  }
});

test("control messages and SSE subscriptions cannot escape the policy", async () => {
  const ws = new WebSocket(`${origin.replace("http:", "ws:")}/exec-ws`, [
    `serve-sim.token.${TOKEN}`,
  ]);
  const replies: Record<string, unknown>[] = [];
  const complete = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("control replies timed out")), 5000);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const reply = JSON.parse(String(raw));
      if (reply.ready) {
        ws.send(JSON.stringify({ id: 1, action: "server.detach", params: { udid: DEVICE } }));
        ws.send(
          JSON.stringify({
            id: 2,
            action: "capture.reboot",
            params: { udid: OTHER, enabled: true },
          }),
        );
        ws.send(
          JSON.stringify({ id: 3, ui: { device: OTHER, option: "appearance", value: "dark" } }),
        );
        ws.send(JSON.stringify({ sub: 4, path: `/api/event-log/events?device=${OTHER}` }));
        return;
      }
      replies.push(reply);
      if (replies.length === 4) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  try {
    await complete;
    for (const reply of replies) expect(reply.error ?? reply.end).toBeTruthy();
    expect(
      replies.filter((r) => r.id).every((r) => String(r.error).includes("single-device")),
    ).toBe(true);
  } finally {
    ws.terminate();
  }
});

test("embedded HID sockets refuse another device", () => {
  let closed = false;
  const ws = {
    on() {},
    close() {
      closed = true;
    },
  };
  const middleware = simMiddleware({ basePath: "/sim", singleDevice: DEVICE });
  expect(
    middleware.handleWebSocket?.(
      new Request(`http://localhost/sim/helper/${OTHER}/ws`, {
        headers: { host: "localhost" },
      }),
      ws as any,
    ),
  ).toBe(true);
  expect(closed).toBe(true);
});

test("single-device mode preserves the preview's authentication gate", async () => {
  const middleware = simMiddleware({
    basePath: "/sim",
    singleDevice: DEVICE,
    execToken: TOKEN,
    requirePreviewToken: true,
  });
  try {
    const refused = await middleware(new Request("http://localhost/sim/api/event-log"));
    expect(refused?.status).toBe(401);
    await refused?.text();
    const allowed = await middleware(
      new Request("http://localhost/sim/api/event-log", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(allowed?.status).toBe(200);
    await allowed?.text();
  } finally {
    await middleware.dispose();
  }
});

test("the pinned preview and state feed recover when a lowercase helper reconnects", async () => {
  const abort = new AbortController();
  const events = await fetch(`${origin}/api/events`, { signal: abort.signal });
  const reader = events.body!.getReader();
  let buffered = "";
  const nextConfig = async () => {
    for (;;) {
      const end = buffered.indexOf("\n\n");
      if (end >= 0) {
        const message = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const data = message.split("\n").find((line) => line.startsWith("data: "));
        if (data) return JSON.parse(data.slice(6));
      } else {
        const { done, value } = await reader.read();
        if (done) throw new Error("State feed closed before the next configuration");
        buffered += new TextDecoder().decode(value);
      }
    }
  };
  let remove = () => {};
  try {
    expect(await nextConfig()).toBeNull();
    remove = recordState(DEVICE.toLowerCase(), process.pid, 1);
    expect((await nextConfig())?.singleDevice).toBe(DEVICE);
    const attached = await (await fetch(`${origin}/api`)).json();
    expect(attached?.device.toUpperCase()).toBe(DEVICE);
    remove();
    expect(await nextConfig()).toBeNull();
    expect(await (await fetch(`${origin}/api`)).json()).toBeNull();
    remove = recordState(DEVICE.toLowerCase(), process.pid, 2);
    expect((await nextConfig())?.port).toBe(2);
    const reconnected = await (await fetch(`${origin}/api`)).json();
    expect(reconnected?.device.toUpperCase()).toBe(DEVICE);
    expect(reconnected?.singleDevice).toBe(DEVICE);
    expect((await fetch(`${origin}/api?device=${OTHER}`)).status).toBe(403);
  } finally {
    remove();
    abort.abort();
    await reader.cancel().catch(() => {});
  }
});
