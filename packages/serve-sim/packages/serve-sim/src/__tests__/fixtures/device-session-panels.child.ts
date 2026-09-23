import { afterEach, expect, mock, test } from "bun:test";
import type { MjpegFrame, NativeCaptureOptions } from "../../native";

const DEVICE = "404F2659-7202-4450-8465-912BD2AB744B";
let supported = true;
const selectedScreens: number[] = [];
const captures: Capture[] = [];
let startBarrier: Promise<void> | undefined;
let settingsBarrier: Promise<void> | undefined;
let offerBarrier: Promise<void> | undefined;
class Capture {
  stopped = false;
  settings: NativeCaptureOptions[];
  callbacks = new Set<(frame: MjpegFrame) => Promise<void>>();
  avcc = new Set<(frame: MjpegFrame & { isDescription: boolean; isKeyframe: boolean }) => Promise<void>>();
  sessions = new Set<string>();
  pendingOffers = 0;
  constructor(_udid: string, options: NativeCaptureOptions, readonly screenId?: number) { this.settings = [options]; captures.push(this); }
  async start() { if (this.screenId) await startBarrier; }
  async stop() { this.stopped = true; }
  async subscribeScreenChanges() { return async () => {}; }
  async screenSize() { return { width: 1398, height: 2034, screenId: this.screenId ?? 1, orientation: "portrait" }; }
  async subscribeMjpeg(callback: (frame: MjpegFrame) => Promise<void>) { this.callbacks.add(callback); return async () => { this.callbacks.delete(callback); }; }
  async subscribeAvcc(callback: (frame: MjpegFrame & { isDescription: boolean; isKeyframe: boolean }) => Promise<void>) { this.avcc.add(callback); return async () => { this.avcc.delete(callback); }; }
  async updateStreamSettings(options: NativeCaptureOptions) { await settingsBarrier; this.settings.push(options); }
  async handleWebRTCOffer(offer: { sessionId: string }) { this.pendingOffers++; await offerBarrier; this.pendingOffers--; this.sessions.add(offer.sessionId); return { type: "answer", sdp: "v=0", sessionId: offer.sessionId }; }
  async closeWebRTCSession(id: string) { this.sessions.delete(id); }
  async webRTCSenderStats() { return { sessions: this.sessions.size }; }
}
const native = await import("../../native");
mock.module("../../native", () => ({
  ...native,
  NativeCapture: Capture,
  NativeHid: class {
    async setScreen(id: number) { selectedScreens.push(id); }
    async supportsHingeAngle() { return supported; }
  },
}));
const { simMiddleware } = await import("../../middleware");
const { closeDeviceSession } = await import("../../device-session");
let middleware = simMiddleware({ basePath: "/sim", device: DEVICE });
const controllers: AbortController[] = [];
async function request(path: string, init: RequestInit = {}) {
  return middleware(new Request(`http://localhost/sim/helper/${DEVICE}/${path}`, init));
}
async function waitUntil(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await Bun.sleep(5); }
  throw new Error("Condition did not settle");
}
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  closeDeviceSession(DEVICE);
  await Bun.sleep(5);
  captures.length = 0; selectedScreens.length = 0; supported = true; startBarrier = undefined; settingsBarrier = undefined; offerBarrier = undefined;
  middleware = simMiddleware({ basePath: "/sim", device: DEVICE });
});

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
function beginStream(screenId: 1 | 3, codec = "mjpeg") {
  const controller = new AbortController();
  controllers.push(controller);
  return { controller, response: request(`panel/${screenId}/stream.${codec}`, { signal: controller.signal }) };
}
async function panelWithSubscribers(screenId: number, count = 1) {
  await waitUntil(() => captures.some((capture) => capture.screenId === screenId && capture.callbacks.size >= count));
  return captures.find((capture) => capture.screenId === screenId)!;
}
const frame = (value: number, width = 2007, height = 2853) => ({ data: Buffer.from([255, 216, value, 255, 217]), width, height }) satisfies MjpegFrame;

test("shares each fixed panel, isolates its frames from active HID/config, and stops after the last subscriber", async () => {
  const first = beginStream(3);
  const inner = await panelWithSubscribers(3);
  const second = beginStream(3);
  await panelWithSubscribers(3, 2);
  const coverStream = beginStream(1);
  const cover = await panelWithSubscribers(1);
  const initialConfig = await (await request("config"))!.json();
  const initialScreens = [...selectedScreens];
  const innerFrames = Promise.all([...inner.callbacks].map((callback) => callback(frame(33))));
  const coverFrames = Promise.all([...cover.callbacks].map((callback) => callback(frame(11, 1398, 2034))));
  for (const stream of [first, second]) {
    const response = await stream.response;
    expect(response!.headers.get("x-screen-id")).toBe("3");
    const chunk = (await response!.body!.getReader().read()).value!;
    expect(Buffer.from(chunk).includes(frame(33).data)).toBe(true);
    expect(Buffer.from(chunk).includes(frame(11).data)).toBe(false);
  }
  const coverResponse = (await coverStream.response)!;
  expect(coverResponse.headers.get("x-screen-id")).toBe("1");
  await coverResponse.body!.getReader().read();
  await Promise.all([innerFrames, coverFrames]);
  expect(await (await request("config"))!.json()).toEqual(initialConfig);
  expect(selectedScreens).toEqual(initialScreens);
  expect(captures.map((capture) => capture.screenId)).toEqual([undefined, 3, 1]);
  first.controller.abort();
  await waitUntil(() => inner.callbacks.size === 1);
  expect(inner.stopped).toBe(false);
  second.controller.abort();
  await waitUntil(() => inner.stopped && inner.callbacks.size === 0);
  expect(cover.stopped).toBe(false);
  coverStream.controller.abort();
  await waitUntil(() => cover.stopped);
});

test("AVCC uses its own panel seed and envelopes without changing the active display", async () => {
  const stream = beginStream(3, "avcc");
  const inner = await panelWithSubscribers(3);
  await waitUntil(() => inner.avcc.size === 1);
  const screens = [...selectedScreens];
  await Promise.all([...inner.callbacks].map((callback) => callback(frame(31))));
  const response = (await stream.response)!;
  const reader = response.body!.getReader();
  const seed = Buffer.from((await reader.read()).value!);
  expect(seed.readUInt32BE(0)).toBe(6);
  expect(seed[4]).toBe(4);
  expect(seed.subarray(5)).toEqual(frame(31).data);
  const envelope = Buffer.from([0, 0, 0, 3, 2, 8, 9]);
  const emitted = Promise.all([...inner.avcc].map((callback) => callback({ ...frame(0), data: envelope, isDescription: false, isKeyframe: true })));
  expect(Buffer.from((await reader.read()).value!)).toEqual(envelope);
  await emitted;
  expect(selectedScreens).toEqual(screens);
  stream.controller.abort();
  await waitUntil(() => inner.stopped && inner.avcc.size === 0);
});

test("rejects unsupported devices and preserves the WebRTC transport lock", async () => {
  supported = false;
  expect((await request("panel/1/stream.mjpeg"))!.status).toBe(409);
  expect(captures.filter((capture) => capture.screenId)).toHaveLength(0);
  closeDeviceSession(DEVICE);
  middleware = simMiddleware({ basePath: "/sim", device: DEVICE, streamSettings: { transport: "webrtc", codec: "h264" } });
  supported = true;
  for (const codec of ["mjpeg", "avcc"]) {
    const response = (await request(`panel/3/stream.${codec}`))!;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "stream_transport_locked" });
  }
  expect(captures.filter((capture) => capture.screenId)).toHaveLength(0);
});

test("keeps WebRTC captures alive after SDP, shares sessions, and closes each panel independently", async () => {
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const coverId = crypto.randomUUID();
  for (const [id, screenId] of [[firstId, 3], [secondId, 3], [coverId, 1]] as const) {
    expect((await request(`panel/${screenId}/webrtc/offer`, json({ type: "offer", sdp: "v=0", sessionId: id })))!.status).toBe(200);
  }
  const inner = captures.find((capture) => capture.screenId === 3)!;
  const cover = captures.find((capture) => capture.screenId === 1)!;
  expect(inner.stopped).toBe(false);
  expect(inner.sessions).toEqual(new Set([firstId, secondId]));
  expect(await (await request("panel/3/webrtc/stats"))!.json()).toEqual({ sessions: 2 });
  expect((await request("panel/3/webrtc/close", json({ sessionId: firstId })))!.status).toBe(204);
  expect(inner.stopped).toBe(false);
  expect((await request("panel/3/webrtc/close", json({ sessionId: secondId })))!.status).toBe(204);
  await waitUntil(() => inner.stopped);
  expect(cover.stopped).toBe(false);
  closeDeviceSession(DEVICE);
  await waitUntil(() => cover.stopped);
  expect(cover.sessions.size).toBe(0);
});

test("does not start capture for stats, close, preflight, or direct-helper invalid IDs", async () => {
  expect((await request("panel/3/webrtc/stats"))!.status).toBe(404);
  expect((await request("panel/3/webrtc/close", json({ sessionId: crypto.randomUUID() })))!.status).toBe(204);
  for (const path of ["panel/3/webrtc/offer", "panel/3/unknown"]) {
    // The shared CORS policy answers preflights before route validation.
    const response = (await request(path, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:4000", "access-control-request-method": "POST" },
    }))!;
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4000");
    expect(await response.text()).toBe("");
  }
  expect((await middleware(new Request(`http://localhost/sim/helper/panel/2/stream.avcc?device=${DEVICE}`)))!.status).toBe(400);
  expect(captures).toHaveLength(0);
});

test("rejects invalid panel routes consistently before creating a capture", async () => {
  for (const [path, method, status, error] of [
    ["panel/01/stream.avcc", "GET", 400, "invalid_panel"],
    ["panel/3/unknown", "GET", 404, "unknown_panel_endpoint"],
    ["panel/1/stream.mjpeg", "POST", 405, "method_not_allowed"],
    ["panel/3/webrtc/offer", "GET", 405, "method_not_allowed"],
    ["panel/1/webrtc/stats", "POST", 405, "method_not_allowed"],
  ] as const) {
    const response = (await request(path, { method }))!;
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  }
  expect(captures).toHaveLength(0);
});

test("cancelling during native startup releases the pending capture without subscribing", async () => {
  let releaseStart!: () => void;
  startBarrier = new Promise((resolve) => { releaseStart = resolve; });
  const stream = beginStream(3);
  await waitUntil(() => captures.some((capture) => capture.screenId === 3));
  const inner = captures.find((capture) => capture.screenId === 3)!;
  stream.controller.abort();
  releaseStart();
  await stream.response.catch(() => undefined);
  await waitUntil(() => inner.stopped);
  expect(inner.callbacks.size).toBe(0);
});

test("serializes encoder updates across existing captures and newly requested panels", async () => {
  const stream = beginStream(1);
  const cover = await panelWithSubscribers(1);
  const coverFrame = Promise.all([...cover.callbacks].map((callback) => callback(frame(1))));
  await (await stream.response)!.body!.getReader().read();
  await coverFrame;
  let releaseSettings!: () => void;
  settingsBarrier = new Promise((resolve) => { releaseSettings = resolve; });
  const update = request("stream-settings", { ...json({ mjpegFps: 24, maxDimension: 900 }), method: "PATCH" });
  await Bun.sleep(10);
  const innerStream = beginStream(3);
  await Bun.sleep(10);
  expect(captures.filter((capture) => capture.screenId === 3)).toHaveLength(0);
  releaseSettings();
  expect((await update)!.status).toBe(200);
  const inner = await panelWithSubscribers(3);
  for (const capture of captures) expect(capture.settings.at(-1)).toMatchObject({ mjpegFps: 24, maxDimension: 900 });
  const innerFrame = Promise.all([...inner.callbacks].map((callback) => callback(frame(3))));
  await (await innerStream.response)!.body!.getReader().read();
  await innerFrame;
});

test("cancelling an in-flight WebRTC answer cannot leave a late native session alive", async () => {
  let releaseOffer!: () => void;
  offerBarrier = new Promise((resolve) => { releaseOffer = resolve; });
  const controller = new AbortController();
  controllers.push(controller);
  const response = request("panel/3/webrtc/offer", { ...json({ type: "offer", sdp: "v=0", sessionId: crypto.randomUUID() }), signal: controller.signal });
  await waitUntil(() => captures.some((capture) => capture.pendingOffers === 1));
  const inner = captures.find((capture) => capture.screenId === 3)!;
  controller.abort();
  await waitUntil(() => inner.stopped);
  releaseOffer();
  await response;
  await waitUntil(() => inner.pendingOffers === 0 && inner.sessions.size === 0);
  expect(inner.sessions.size).toBe(0);
});

test("rejects invalid panel IDs and methods before creating a fixed capture", async () => {
  expect((await request("panel/2/stream.mjpeg"))?.status).toBe(400);
  expect((await request("panel/1/stream.mjpeg", { method: "POST" }))?.status).toBe(405);
  expect(captures.filter((capture) => capture.screenId)).toHaveLength(0);
});
