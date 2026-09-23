import { afterEach, expect, mock, test } from "bun:test";
import type { UseAvccStreamOptions } from "../../client/simulator/use-avcc-stream";

// Execute each hook's real effect and cleanup in isolation. Browser decoding
// and fetch delivery are controlled so retired callbacks can arrive late.
const effects: Array<() => void | (() => void)> = [];
const cleanups: Array<() => void> = [];
mock.module("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));
function startEffects() {
  const pending = effects.splice(0);
  const active = pending.map((effect) => effect()).filter((cleanup) => typeof cleanup === "function");
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; for (const cleanup of active) cleanup(); } };
  cleanups.push(stop);
  return stop;
}

class Frame {
  closed = false;
  constructor(readonly label: string, readonly displayWidth = 2007, readonly displayHeight = 2853) {}
  get width() { return this.displayWidth; }
  get height() { return this.displayHeight; }
  close() { this.closed = true; }
}
class Canvas {
  width = 300;
  height = 150;
  frames: string[] = [];
  getContext() { return { drawImage: (frame: Frame) => { this.frames.push(frame.label); } }; }
}
const decoders: Decoder[] = [];
class Decoder {
  state = "unconfigured";
  configs: VideoDecoderConfig[] = [];
  constructor(readonly callbacks: { output: (frame: Frame) => void; error: (error: Error) => void }) { decoders.push(this); }
  configure(config: VideoDecoderConfig) { this.configs.push(config); this.state = "configured"; }
  decode() {}
  close() { this.state = "closed"; }
}
const pendingBitmaps: Array<(frame: Frame) => void> = [];
const requests: Array<{ url: string; signal: AbortSignal; controller: ReadableStreamDefaultController<Uint8Array> }> = [];
const objectUrls = new Map<string, Blob>();
let objectUrlId = 0;
Object.assign(globalThis, {
  VideoDecoder: Decoder,
  createImageBitmap: () => new Promise<Frame>((resolve) => { pendingBitmaps.push(resolve); }),
  fetch: (url: string, options: { signal: AbortSignal }) => Promise.resolve({
    body: new ReadableStream<Uint8Array>({ start(controller) { requests.push({ url, signal: options.signal, controller }); } }),
  }),
});
URL.createObjectURL = (blob) => { const url = `blob:test-${++objectUrlId}`; objectUrls.set(url, blob as Blob); return url; };
URL.revokeObjectURL = (url) => { objectUrls.delete(url); };
const { useAvccStream } = await import("../../client/simulator/use-avcc-stream");
const { useMjpegStream } = await import("../../client/hooks/use-mjpeg-stream");

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const { controller } of requests.splice(0)) controller.close();
  decoders.length = 0;
  pendingBitmaps.length = 0;
  objectUrls.clear();
});
async function tick() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
function chunk(tag: number, payload = new Uint8Array([1, 100, 0, 40])) {
  const bytes = new Uint8Array(payload.length + 5);
  new DataView(bytes.buffer).setUint32(0, payload.length + 1);
  bytes[4] = tag; bytes.set(payload, 5);
  return bytes;
}
function jpegPart() {
  const header = new TextEncoder().encode("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 6\r\n\r\n");
  return new Uint8Array([...header, 0xff, 0xd8, 1, 2, 0xff, 0xd9]);
}
function avcc(url = "http://localhost/helper/device/panel/3", callbacks: Partial<UseAvccStreamOptions> = {}) {
  const canvas = new Canvas();
  useAvccStream({ url, enabled: true, canvasRef: { current: canvas as unknown as HTMLCanvasElement }, ...callbacks });
  return { canvas, stop: startEffects() };
}

test("a delayed JPEG seed cannot overwrite a newer decoded frame or its dimensions", async () => {
  let decoded = 0;
  const { canvas } = avcc(undefined, { onDecodedFrame: () => decoded++ });
  await tick();
  requests[0]!.controller.enqueue(chunk(4));
  requests[0]!.controller.enqueue(chunk(1));
  await tick();
  const video = new Frame("new inner frame");
  decoders[0]!.callbacks.output(video);
  const seed = new Frame("old cover seed", 1398, 2034);
  pendingBitmaps[0]!(seed);
  await tick();
  expect(canvas.frames).toEqual(["new inner frame"]);
  expect([canvas.width, canvas.height]).toEqual([2007, 2853]);
  expect(decoded).toBe(1);
  expect(video.closed && seed.closed).toBe(true);
});

test("new AVCC descriptions retire the previous decoder and its queued callbacks", async () => {
  let errors = 0;
  const { canvas } = avcc(undefined, { onDecoderError: () => errors++ });
  await tick();
  requests[0]!.controller.enqueue(chunk(1)); await tick();
  const previous = decoders[0]!;
  requests[0]!.controller.enqueue(chunk(1)); await tick();
  expect(decoders).toHaveLength(2);
  expect(previous.state).toBe("closed");
  const retired = new Frame("retired dimensions", 1398, 2034);
  previous.callbacks.output(retired);
  previous.callbacks.error(new Error("late retired decoder error"));
  decoders[1]!.callbacks.output(new Frame("current frame"));
  expect(canvas.frames).toEqual(["current frame"]);
  expect(errors).toBe(0);
  expect(retired.closed).toBe(true);
  expect(decoders[1]!.configs[0]!.optimizeForLatency).toBe(true);
});

test("unmount ignores delayed decoder errors and releases pending bitmap output", async () => {
  let errors = 0;
  const { canvas, stop } = avcc(undefined, { onDecoderError: () => errors++ });
  await tick();
  requests[0]!.controller.enqueue(chunk(1));
  requests[0]!.controller.enqueue(chunk(4)); await tick();
  stop();
  const bitmap = new Frame("late seed");
  pendingBitmaps[0]!(bitmap);
  decoders[0]!.callbacks.error(new Error("decoder shutdown"));
  const video = new Frame("late video");
  decoders[0]!.callbacks.output(video); await tick();
  expect(canvas.frames).toEqual([]);
  expect(errors).toBe(0);
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(bitmap.closed && video.closed).toBe(true);
});

test("fixed cover and inner routes keep independent decoders and lifetimes", async () => {
  const cover = avcc("http://localhost/helper/device/panel/1");
  const inner = avcc("http://localhost/helper/device/panel/3");
  await tick();
  expect(requests.map(({ url }) => url)).toEqual([
    "http://localhost/helper/device/panel/1/stream.avcc",
    "http://localhost/helper/device/panel/3/stream.avcc",
  ]);
  for (const request of requests) request.controller.enqueue(chunk(1)); await tick();
  decoders[0]!.callbacks.output(new Frame("cover", 1398, 2034));
  decoders[1]!.callbacks.output(new Frame("inner"));
  cover.stop();
  decoders[1]!.callbacks.output(new Frame("inner after cover unmount"));
  expect(cover.canvas.frames).toEqual(["cover"]);
  expect(inner.canvas.frames).toEqual(["inner", "inner after cover unmount"]);
  expect(decoders.map(({ state }) => state)).toEqual(["closed", "configured"]);
  expect(requests[1]!.signal.aborted).toBe(false);
});

test("the JPEG seed still paints promptly before H.264 is ready", async () => {
  let first = 0; let decoded = 0;
  const { canvas } = avcc(undefined, { onFirstFrame: () => first++, onDecodedFrame: () => decoded++ });
  await tick();
  requests[0]!.controller.enqueue(chunk(4)); await tick();
  pendingBitmaps[0]!(new Frame("seed")); await tick();
  expect(canvas.frames).toEqual(["seed"]);
  expect(first).toBe(1);
  expect(decoded).toBe(0);
});

test("MJPEG subscribers own independent URLs for the same frame", async () => {
  const frames: string[] = [];
  const { subscribeFrame } = useMjpegStream("http://localhost/helper/device/panel/1/stream.mjpeg");
  subscribeFrame((url) => { frames.push(url); URL.revokeObjectURL(url); });
  subscribeFrame((url) => { frames.push(url); });
  startEffects(); await tick();
  requests[0]!.controller.enqueue(jpegPart()); await tick();
  expect(frames).toHaveLength(2);
  expect(frames[0]).not.toBe(frames[1]);
  expect(objectUrls.has(frames[0]!)).toBe(false);
  expect(objectUrls.has(frames[1]!)).toBe(true);
  expect(Array.from(new Uint8Array(await objectUrls.get(frames[1]!)!.arrayBuffer()))).toEqual([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
});

test("MJPEG chunks delivered after cleanup cannot reach a retired subscriber", async () => {
  const frames: string[] = [];
  const { subscribeFrame } = useMjpegStream("http://localhost/helper/device/panel/1/stream.mjpeg");
  subscribeFrame((url) => { frames.push(url); });
  const stop = startEffects(); await tick();
  stop();
  requests[0]!.controller.enqueue(jpegPart()); await tick();
  expect(frames).toEqual([]);
  expect(objectUrls.size).toBe(0);
});
