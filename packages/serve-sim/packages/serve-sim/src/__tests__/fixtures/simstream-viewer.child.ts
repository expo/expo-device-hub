import { afterEach, expect, mock, test } from "bun:test";

// A minimal React: each mount keeps its own hook slots, and effects run when the test says so.
let slots: unknown[] = [];
let slot = 0;
const effects: Array<() => void | (() => void)> = [];
const cleanups: Array<() => void> = [];
mock.module("react", () => ({
  useState: (initial: unknown) => {
    const index = slot++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [slots[index], (next: unknown) => {
      slots[index] = typeof next === "function" ? (next as (previous: unknown) => unknown)(slots[index]) : next;
    }];
  },
  useRef: (current: unknown) => {
    const index = slot++;
    if (!(index in slots)) slots[index] = { current };
    return slots[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));
/** Renders a fresh mount of `hook` and runs its effects; returns a re-render that reads its state. */
function mount<T>(hook: () => T) {
  slots = [];
  slot = 0;
  hook();
  const active = effects.splice(0).map((effect) => effect()).filter((cleanup) => typeof cleanup === "function");
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; for (const cleanup of active) cleanup(); } };
  cleanups.push(stop);
  const render = () => { slot = 0; const result = hook(); effects.length = 0; return result; };
  return { render, stop };
}

const storage = new Map<string, string>();
const sockets: FakeSocket[] = [];
const peers: FakePeer[] = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send(data: string) { this.sent.push(data); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }
  receive(message: object | string) {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
}
type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const H264_ANSWER = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n";
const VP8_ONLY_ANSWER = "v=0\r\nm=video 0 UDP/TLS/RTP/SAVPF 97\r\na=rtpmap:97 VP8/90000\r\n";
let answerSdp = H264_ANSWER;
class FakePeer {
  connectionState = "new";
  closed = false;
  remote = deferred();
  calls: string[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() { peers.push(this); }
  setRemoteDescription() { this.calls.push("setRemoteDescription"); return this.remote.promise; }
  async createAnswer() { this.calls.push("createAnswer"); return { type: "answer", sdp: answerSdp }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.calls.push("setLocalDescription"); this.localDescription = description; }
  async addIceCandidate() {}
  close() { this.closed = true; }
}
Object.assign(globalThis, {
  WebSocket: FakeSocket,
  RTCPeerConnection: FakePeer,
  window: {
    location: { search: "" },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
  },
  document: { hidden: false, addEventListener() {}, removeEventListener() {} },
});
const { useStreamSettings } = await import("../../client/hooks/use-stream-settings");
const { useSimstreamRtpStream } = await import("../../client/simulator/use-simstream-rtp-stream");

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  storage.clear();
  sockets.length = 0;
  peers.length = 0;
  answerSdp = H264_ANSWER;
});
async function tick() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
const OFFER = { t: "sdp", type: "offer", sdp: "v=0\r\n" };

test("a reload restores simstream and its RTP transport after both are chosen", () => {
  const first = mount(() => useStreamSettings({ device: "device" }));
  first.render().updatePlayback({ httpCodec: "simstream" });
  first.render().updatePlayback({ simstreamTransport: "rtp" });
  expect(first.render().settings).toMatchObject({ httpCodec: "simstream", simstreamTransport: "rtp" });
  first.stop();

  const reloaded = mount(() => useStreamSettings({ device: "device" }));
  expect(reloaded.render().settings).toMatchObject({ transport: "http", httpCodec: "simstream", simstreamTransport: "rtp" });
});

function rtp() {
  return mount(() => useSimstreamRtpStream({ url: "http://localhost:3200/helper/device", enabled: true }));
}

test("answers the bridge's offer", async () => {
  const { render } = rtp();
  sockets[0]!.receive(OFFER);
  peers[0]!.remote.resolve();
  await tick();
  expect(peers[0]!.calls).toEqual(["setRemoteDescription", "createAnswer", "setLocalDescription"]);
  expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ t: "sdp", type: "answer", sdp: H264_ANSWER });
  expect(render().error).toBeNull();
});

test("a rejected offer releases the connection, names WebSocket, and doesn't retry", async () => {
  const { render } = rtp();
  sockets[0]!.receive(OFFER);
  peers[0]!.remote.reject(new Error("Failed to parse SessionDescription"));
  await tick();
  expect(render().error).toContain("Failed to parse SessionDescription");
  expect(render().error).toContain("WebSocket transport");
  expect(peers[0]!.closed).toBe(true);
  expect(sockets[0]!.readyState).toBe(3);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(sockets).toHaveLength(1);
  expect(render().error).toContain("WebSocket transport");
});

test("a browser that can't play H.264 is sent to the WebSocket transport", async () => {
  answerSdp = VP8_ONLY_ANSWER;
  const { render } = rtp();
  sockets[0]!.receive(OFFER);
  peers[0]!.remote.resolve();
  await tick();
  expect(render().error).toContain("can't play H.264");
  expect(render().error).toContain("WebSocket transport");
  expect(peers[0]!.calls).not.toContain("setLocalDescription");
  expect(sockets[0]!.sent).toEqual([]);
  expect(peers[0]!.closed).toBe(true);
});

test("negotiation that finishes after unmount touches nothing", async () => {
  const { render, stop } = rtp();
  sockets[0]!.receive(OFFER);
  stop();
  peers[0]!.remote.resolve();
  await tick();
  expect(peers[0]!.calls).toEqual(["setRemoteDescription"]);
  expect(sockets[0]!.sent).toEqual([]);
  expect(render().error).toBeNull();

  const second = rtp();
  sockets[1]!.receive(OFFER);
  second.stop();
  peers[1]!.remote.reject(new Error("late failure"));
  await tick();
  expect(second.render().error).toBeNull();
});

test("a malformed signaling message is an error, not an unhandled rejection", async () => {
  const { render } = rtp();
  sockets[0]!.receive("{");
  await tick();
  expect(render().error).toContain("malformed");
  expect(peers[0]!.closed).toBe(true);
});
