import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { sessionTokenFetch } from "../../session-token";
import { PLAYBACK_STALL_POLLS, PLAYBACK_STALL_POLL_MS } from "../../webrtc-playback-stall";

let effects: (() => void | (() => void))[] = [];
let updates: unknown[] = [];
let pendingStats: { resolve: (value: Map<string, unknown>) => void }[] = [];
let peers: FakePeer[] = [];
let closed = 0;
let visibility: "visible" | "hidden" = "visible";
const visibilityListeners = new Set<() => void>();
const visibilityListener = () => visibilityListeners.forEach((listener) => listener());
let nextTimer = 0;
const timers = new Map<number, { callback: () => void; delay: number }>();
let nextInterval = 0;
const intervals = new Map<number, () => void>();
const POLL_MS = PLAYBACK_STALL_POLL_MS;
let clock = 0;
/// What the signalling endpoint answers the offer with.
let offerStatus = 200;
let offersPosted = 0;
let offerBody = "nope";
let offerResponses: Response[] = [];
let senderFrames = 0;
let captureRebooting: unknown = undefined;
let senderReply: (() => Promise<Response>) | undefined;
let statsAuthorization: string | null = null;
let statsSignal: AbortSignal | null = null;

class FakePeer {
  connectionState = "connected";
  iceGatheringState = "complete";
  localDescription = { type: "offer", sdp: "v=0" };
  onconnectionstatechange?: () => void;
  ontrack?: (event: { track: object; streams: object[] }) => void;
  constructor() {
    peers.push(this);
  }
  addTransceiver() {
    return {};
  }
  async createOffer() {
    return this.localDescription;
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  getStats() {
    return new Promise<Map<string, unknown>>((resolve) => pendingStats.push({ resolve }));
  }
  close() {
    closed += 1;
  }
}

mock.module("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, (update: unknown) => updates.push(update)],
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
  useLayoutEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));

function fakeSetTimeout(callback: () => void, delay = 0) {
  timers.set(++nextTimer, { callback, delay });
  return nextTimer;
}
function fakeClearTimeout(id: number) {
  timers.delete(id);
}

function fakeSetInterval(callback: () => void) {
  intervals.set(++nextInterval, callback);
  return nextInterval;
}
function fakeClearInterval(id: number) {
  intervals.delete(id);
}

Object.assign(globalThis, {
  // `startExclusivePoll` and the signalling busy loop reach for the global timers.
  setInterval: fakeSetInterval,
  clearInterval: fakeClearInterval,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  document: {
    get hidden() {
      return visibility === "hidden";
    },
    get visibilityState() {
      return visibility;
    },
    addEventListener(name: string, listener: () => void) {
      if (name === "visibilitychange") visibilityListeners.add(listener);
    },
    removeEventListener(name: string, listener: () => void) {
      if (name === "visibilitychange") visibilityListeners.delete(listener);
    },
  },
  window: {
    location: { href: "http://local/" },
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  // Controlled clock: the gap guard and the read deadline are both wall-clock decisions, and
  // a real `performance.now()` advances ~1ms per tick here, so neither would ever be reached.
  performance: { now: () => clock },
  Date: Object.assign(Date, { now: () => clock }),
  RTCPeerConnection: FakePeer,
  RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
  MediaStream: class {},
  fetch: async (value: string | URL, init?: RequestInit) => {
    const input = String(value);
    if (input.includes("/stats")) {
      statsAuthorization = new Headers(init?.headers).get("authorization");
      statsSignal = init?.signal ?? null;
      if (senderReply) return senderReply();
      return new Response(
        JSON.stringify({
          capture: { rebooting: captureRebooting },
          sessions: [
            {
              sessionId: new URL(input).searchParams.get("sessionId"),
              framesEncoded: senderFrames,
            },
          ],
        }),
      );
    }
    if (input.includes("/offer")) {
      offersPosted += 1;
      if (offerResponses.length > 0) return offerResponses.shift()!;
    }
    if (input.includes("/offer") && offerStatus !== 200) {
      return new Response(offerBody, { status: offerStatus });
    }
    return new Response(JSON.stringify({ type: "answer", sdp: "" }));
  },
});

// Import after mocking React and the browser surface so this exercises the real hook.
const { useWebRtcStream } = await import("../../useWebRtcStream");
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
let cleanup: (void | (() => void))[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop?.());
});

/// Options a test passes to the hook on top of the defaults. Reset by every `start`.
let hookOptions: {
  allowCodecFallback?: boolean;
  expectContinuousFrames?: boolean;
  fetchImpl?: Parameters<typeof useWebRtcStream>[0]["fetchImpl"];
} = {};

async function start(
  visible: "visible" | "hidden" = "visible",
  offerAnswers = 200,
  transportLocked = true,
  responses: Response[] = [],
) {
  cleanup.splice(0).forEach((stop) => stop?.());
  effects = [];
  updates = [];
  pendingStats = [];
  peers = [];
  closed = 0;
  visibility = visible;
  offerStatus = offerAnswers;
  offersPosted = 0;
  offerBody = "nope";
  offerResponses = responses;
  senderFrames = 0;
  captureRebooting = undefined;
  senderReply = undefined;
  statsAuthorization = null;
  statsSignal = null;
  clock = 0;
  timers.clear();
  intervals.clear();
  const hook = useWebRtcStream({
    offerUrl: "http://local/offer",
    closeUrl: "http://local/close",
    statsUrl: "http://local/stats",
    enabled: true,
    codec: "h264",
    transportLocked,
    ...hookOptions,
  });
  hookOptions = {};
  cleanup = effects.map((effect) => effect());
  await flush();
  peers[0]?.ontrack?.({ track: {}, streams: [{}] });
  peers[0]?.onconnectionstatechange?.();
  return hook;
}

// Re-run the stream effect without remounting so same-codec retry refs survive.
async function reconnect() {
  const streamEffect = effects.length - 1;
  cleanup[streamEffect]?.();
  pendingStats = [];
  peers = [];
  cleanup[streamEffect] = effects[streamEffect]!();
  await flush();
  peers[0]?.ontrack?.({ track: {}, streams: [{}] });
  peers[0]?.onconnectionstatechange?.();
}

function fireTimer(delay: number) {
  const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
  if (!entry) throw new Error(`Expected a ${delay}ms timer`);
  timers.delete(entry[0]);
  entry[1].callback();
}

function resolveStats(
  framesReceived: number,
  framesDecoded = framesReceived,
  id = "video",
  mediaTypeOnly = false,
) {
  const read = pendingStats.shift();
  if (!read) throw new Error("Expected an inbound stats read");
  read.resolve(
    new Map([
      [
        id,
        {
          id,
          type: "inbound-rtp",
          [mediaTypeOnly ? "mediaType" : "kind"]: "video",
          framesReceived,
          framesDecoded,
        },
      ],
    ]),
  );
}

/// Drive the stall watchdog with one sample per poll, advancing the clock like a real timer.
/// `gapMs` fakes a sleep between two polls without raising visibilitychange.
async function pollStall(
  samples: { received: number; decoded: number; id?: string; mediaTypeOnly?: boolean }[],
  gapMs = POLL_MS,
) {
  for (const sample of samples) {
    clock += gapMs;
    for (const tick of intervals.values()) tick();
    await flush();
    if (pendingStats.length > 0)
      resolveStats(sample.received, sample.decoded, sample.id, sample.mediaTypeOnly);
    await flush();
  }
}

/// One more sample than the threshold needs, so the run reaches a verdict.
function frozenRun(decoded: number, from = decoded) {
  return Array.from({ length: PLAYBACK_STALL_POLLS + 1 }, (_, i) => ({
    received: from + i * 100,
    decoded,
  }));
}

/// Nothing arriving at all: the path is dead, not the decoder.
function deadRun(at: number) {
  return Array.from({ length: PLAYBACK_STALL_POLLS + 1 }, () => ({ received: at, decoded: at }));
}

const STALLED = "WebRTC playback stalled. Retrying...";

function failures() {
  return updates.filter(
    (value): value is { kind: string } =>
      typeof value === "object" && value !== null && "kind" in value,
  );
}

test("the first stall reconnects on the same codec", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100));
  expect(failures()).toEqual([]);
  expect(updates).toContain(STALLED);
});

test("mediaType-only receiver reports still recover a frozen decoder", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100).map((sample) => ({ ...sample, mediaTypeOnly: true })));
  expect(failures()).toEqual([]);
  expect(updates).toContain(STALLED);
});

test("a hung stats read does not reconnect video that keeps presenting frames", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  for (let poll = 0; poll < 12; poll++) {
    clock += POLL_MS;
    for (const tick of intervals.values()) tick();
    await flush();
    hook.markFrameDecoded();
    const deadline = [...timers.entries()].find(([, timer]) => timer.delay === 2_000);
    expect(deadline).toBeDefined();
    clock += 2_000;
    timers.delete(deadline![0]);
    deadline![1].callback();
    await flush();
  }
  expect(pendingStats).toHaveLength(1);
  expect(closed).toBe(0);
  expect(updates).not.toContain(STALLED);
});

test("a stall with no media arriving is charged to the transport", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(deadRun(100));
  expect(failures()).toEqual([]);
  expect(updates).toContain(STALLED);
});

test("a change-driven Android source stays connected through 30-second idle periods", async () => {
  hookOptions = { allowCodecFallback: false, expectContinuousFrames: false };
  const hook = await start();
  hook.markFrameDecoded();
  for (let period = 0; period < 3; period++) {
    const at = 100 + period;
    await pollStall(Array.from({ length: 30 }, () => ({ received: at, decoded: at })));
  }
  expect(closed).toBe(0);
  expect(failures()).toEqual([]);
  expect(updates).not.toContain(STALLED);
});

test("idle time does not spend a newly arriving Android frame's decode deadline", async () => {
  hookOptions = { allowCodecFallback: false, expectContinuousFrames: false };
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(Array.from({ length: 8 }, () => ({ received: 100, decoded: 100 })));
  await pollStall([
    { received: 101, decoded: 100 },
    { received: 101, decoded: 101 },
  ]);
  expect(closed).toBe(0);
  expect(updates).not.toContain(STALLED);
});

test("one newly arriving Android frame gets a full deadline before decoder recovery", async () => {
  hookOptions = { allowCodecFallback: false, expectContinuousFrames: false };
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(Array.from({ length: 8 }, () => ({ received: 100, decoded: 100 })));
  await pollStall(
    Array.from({ length: PLAYBACK_STALL_POLLS - 1 }, () => ({ received: 101, decoded: 100 })),
  );
  expect(closed).toBe(0);
  await pollStall([{ received: 101, decoded: 100 }]);
  expect(closed).toBe(1);
  expect(updates).toContain(STALLED);
});

test("an idle Android source still recovers when arriving frames stop decoding", async () => {
  hookOptions = { allowCodecFallback: false, expectContinuousFrames: false };
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(Array.from({ length: 30 }, () => ({ received: 100, decoded: 100 })));
  await pollStall(frozenRun(100, 101));
  expect(closed).toBe(1);
  expect(updates).toContain(STALLED);
  expect(failures()).toEqual([]);
});

test("a decoder that catches up never reports a stall", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall([
    { received: 100, decoded: 100 },
    { received: 200, decoded: 100 },
    { received: 300, decoded: 100 },
    { received: 400, decoded: 220 },
    { received: 500, decoded: 320 },
    { received: 600, decoded: 420 },
  ]);
  expect(failures()).toEqual([]);
  expect(updates).not.toContain(STALLED);
});

test("a long gap between polls ends the run even with no visibility event", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100).slice(0, PLAYBACK_STALL_POLLS));
  await pollStall([{ received: 400, decoded: 100 }], 20 * 60_000);
  await pollStall([
    { received: 500, decoded: 100 },
    { received: 600, decoded: 100 },
  ]);
  expect(updates).not.toContain(STALLED);
});

test("a hidden tab never trips the stall watchdog", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  visibility = "hidden";
  visibilityListener?.();
  for (let i = 0; i < 8; i++) {
    for (const tick of intervals.values()) tick();
    await flush();
  }
  expect(pendingStats).toHaveLength(0);
  expect(failures()).toEqual([]);
});

test("a repeated decoder stall demotes only after a same-codec reconnect", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100));
  expect(failures()).toEqual([]);
  await reconnect();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100));
  expect(failures()).toMatchObject([{ kind: "codec", codec: "h264" }]);
});

test("Android retries its transport instead of walking the iOS codec ladder", async () => {
  hookOptions = { allowCodecFallback: false, expectContinuousFrames: false };
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100));
  await reconnect();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100));
  expect(failures()).toEqual([]);
  expect(updates).toContain(STALLED);
});

test("stats subscribers share the watchdog's single read", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  const reports: number[] = [];
  const unsubscribe = hook.subscribeStats((report) => reports.push(report.size));
  await pollStall([{ received: 100, decoded: 100 }]);
  expect(reports).toEqual([1]);
  expect(pendingStats).toHaveLength(0);
  unsubscribe();
  await pollStall([{ received: 200, decoded: 200 }]);
  expect(reports).toEqual([1]);
});

test("brief hide/show between polls invalidates the decoder-stall run", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100).slice(0, PLAYBACK_STALL_POLLS));
  visibility = "hidden";
  visibilityListener();
  clock += 200;
  visibility = "visible";
  visibilityListener();
  await pollStall([{ received: 1000, decoded: 100 }]);
  expect(updates).not.toContain(STALLED);
});

test("first-frame watchdog pauses while hidden and restarts on resume", async () => {
  const hook = await start("hidden");
  expect(timers.size).toBe(0);
  visibility = "visible";
  visibilityListener?.();
  fireTimer(4_000);
  await flush();
  resolveStats(10);
  await flush();
  visibility = "hidden";
  visibilityListener?.();
  expect(timers.size).toBe(0);
  expect(failures()).toEqual([]);
  visibility = "visible";
  visibilityListener?.();
  hook.markFrameDecoded();
  expect(timers.size).toBe(0);
});

test("foreground resume keeps a used first-frame grace", async () => {
  await start();
  fireTimer(4_000);
  await flush();
  resolveStats(10);
  await flush();
  visibility = "hidden";
  visibilityListener();
  visibility = "visible";
  visibilityListener();
  fireTimer(4_000);
  await flush();
  resolveStats(20);
  await flush();
  expect(failures()).toMatchObject([{ kind: "codec", codec: "h264" }]);
});

test("teardown cancels a pending sender diagnosis", async () => {
  await start();
  fireTimer(4_000);
  await flush();
  resolveStats(0);
  await flush();
  expect(statsSignal?.aborted).toBe(false);
  cleanup.splice(0).forEach((stop) => stop?.());
  expect(statsSignal?.aborted).toBe(true);
});

test("first-frame decision uses connection state when stats arrive", async () => {
  await start();
  fireTimer(4_000);
  await flush();
  peers[0]!.connectionState = "disconnected";
  resolveStats(0);
  await flush();
  expect(failures()).toEqual([]);
  expect(updates).toContain("WebRTC did not establish a video path. Retrying...");
});

test("a hidden and resumed first-frame read cannot judge the new generation", async () => {
  await start();
  fireTimer(4_000);
  await flush();
  visibility = "hidden";
  visibilityListener?.();
  visibility = "visible";
  visibilityListener?.();
  resolveStats(0);
  await flush();
  expect(failures()).toEqual([]);
  expect([...timers.values()].some((timer) => timer.delay === 4_000)).toBe(true);
});

test("an encoding sender with no received frames retries transport", async () => {
  await start();
  senderFrames = 50;
  fireTimer(4_000);
  await flush();
  resolveStats(0);
  await flush();
  expect(failures()).toEqual([]);
  expect(updates).toContain("WebRTC did not establish a video path. Retrying...");
});

test("hung first-frame stats reach a finite decision", async () => {
  await start();
  fireTimer(4_000);
  await flush();
  fireTimer(2_000);
  await flush();
  expect(failures()).toMatchObject([{ kind: "codec" }]);
});

test("first-frame sender diagnosis retains the session bearer", async () => {
  hookOptions = { fetchImpl: sessionTokenFetch("token-A") };
  await start();
  senderFrames = 50;
  fireTimer(4_000);
  await flush();
  resolveStats(0);
  await flush();
  expect(statsAuthorization).toBe("Bearer token-A");
  expect(updates).toContain("WebRTC did not establish a video path. Retrying...");
});

for (const received of [0, 10]) {
  test(`capture reboot rearms first-frame diagnosis with ${received} received frames`, async () => {
    await start();
    captureRebooting = true;
    for (let window = 0; window < 3; window++) {
      fireTimer(4_000);
      await flush();
      resolveStats(received);
      await flush();
      expect(closed).toBe(0);
      expect(failures()).toEqual([]);
    }
    captureRebooting = false;
    fireTimer(4_000);
    await flush();
    resolveStats(received);
    await flush();
    if (received > 0) {
      // Reboot does not consume the ordinary first-paint grace.
      expect(closed).toBe(0);
      fireTimer(4_000);
      await flush();
      resolveStats(received);
      await flush();
    }
    expect(failures()).toMatchObject([{ kind: "codec", codec: "h264" }]);
  });
}

test("capture reboot pauses established recovery without spending the codec retry", async () => {
  const hook = await start();
  hook.markFrameDecoded();
  captureRebooting = true;
  await pollStall(frozenRun(100));
  await pollStall(frozenRun(100, 1000));
  expect(closed).toBe(0);
  expect(updates).not.toContain(STALLED);
  captureRebooting = false;
  await pollStall(frozenRun(100, 2000));
  expect(closed).toBe(1);
  expect(failures()).toEqual([]);
  expect(updates).toContain(STALLED);
  await reconnect();
  hook.markFrameDecoded();
  await pollStall(frozenRun(100));
  expect(failures()).toMatchObject([{ kind: "codec", codec: "h264" }]);
});

for (const rebooting of [false, undefined, "true"]) {
  test(`non-reboot metadata ${String(rebooting)} retains first-frame and established recovery`, async () => {
    await start();
    captureRebooting = rebooting;
    fireTimer(4_000);
    await flush();
    resolveStats(0);
    await flush();
    expect(failures()).toMatchObject([{ kind: "codec" }]);
    const hook = await start();
    hook.markFrameDecoded();
    captureRebooting = rebooting;
    await pollStall(deadRun(100));
    expect(closed).toBe(1);
    expect(updates).toContain(STALLED);
  });
}

for (const reply of [
  async () => new Response("unavailable", { status: 503 }),
  async () => new Response("{invalid json"),
  async () => {
    throw new Error("network unavailable");
  },
]) {
  test("unavailable sender diagnostics do not disable first-frame or stall recovery", async () => {
    await start();
    senderReply = reply;
    fireTimer(4_000);
    await flush();
    resolveStats(0);
    await flush();
    expect(failures()).toMatchObject([{ kind: "codec" }]);
    const hook = await start();
    hook.markFrameDecoded();
    senderReply = reply;
    await pollStall(deadRun(100));
    expect(closed).toBe(1);
    expect(updates).toContain(STALLED);
  });
}

function deferSender() {
  let resolve!: (response: Response) => void;
  senderReply = () =>
    new Promise<Response>((done) => {
      resolve = done;
    });
  return (rebooting: boolean) => resolve(new Response(JSON.stringify({ capture: { rebooting } })));
}

for (const phase of ["first-frame", "established"]) {
  for (const interruption of ["unmount", "visibility", "replacement"]) {
    test(`late ${phase} sender response cannot recover after ${interruption}`, async () => {
      const hook = await start();
      const finish = deferSender();
      if (phase === "established") {
        hook.markFrameDecoded();
        await pollStall(frozenRun(100));
      } else {
        fireTimer(4_000);
        await flush();
        resolveStats(0);
        await flush();
      }
      const signal = statsSignal;
      expect(signal).not.toBeNull();
      expect(signal?.aborted).toBe(false);
      if (interruption === "unmount") cleanup.splice(0).forEach((stop) => stop?.());
      if (interruption === "replacement") await reconnect();
      if (interruption === "visibility") {
        visibility = "hidden";
        visibilityListener();
        visibility = "visible";
        visibilityListener();
      }
      const closedBeforeReply = closed;
      finish(false);
      await flush();
      expect(closed).toBe(closedBeforeReply);
      expect(failures()).toEqual([]);
      expect(updates).not.toContain(STALLED);
      if (interruption !== "visibility") expect(signal?.aborted).toBe(true);
    });
  }
}

test("a first paint while sender diagnostics are pending cancels first-frame recovery", async () => {
  const hook = await start();
  const finish = deferSender();
  fireTimer(4_000);
  await flush();
  resolveStats(0);
  await flush();
  hook.markFrameDecoded();
  finish(false);
  await flush();
  expect(closed).toBe(0);
  expect(failures()).toEqual([]);
  expect([...timers.values()].some((timer) => timer.delay === 4_000)).toBe(false);
});

test("reboot restores a first-frame grace already used before capture paused", async () => {
  await start();
  fireTimer(4_000);
  await flush();
  resolveStats(10);
  await flush();
  captureRebooting = true;
  fireTimer(4_000);
  await flush();
  resolveStats(20);
  await flush();
  captureRebooting = false;
  fireTimer(4_000);
  await flush();
  resolveStats(30);
  await flush();
  expect(closed).toBe(0);
  fireTimer(4_000);
  await flush();
  resolveStats(40);
  await flush();
  expect(failures()).toMatchObject([{ kind: "codec" }]);
});

test("a pending established sender check shares one poll and retains the session bearer", async () => {
  hookOptions = { fetchImpl: sessionTokenFetch("token-A") };
  const hook = await start();
  hook.markFrameDecoded();
  const finish = deferSender();
  await pollStall(frozenRun(100));
  expect(statsAuthorization).toBe("Bearer token-A");
  await pollStall(frozenRun(100, 1000));
  expect(pendingStats).toHaveLength(0);
  expect(closed).toBe(0);
  finish(true);
  await flush();
  captureRebooting = false;
  senderReply = undefined;
  await pollStall(frozenRun(100, 2000));
  expect(closed).toBe(1);
});

for (const phase of ["first-frame", "established"]) {
  test(`a hung ${phase} sender request reaches its abort deadline and recovers`, async () => {
    const hook = await start();
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      expect(delay).toBe(2_000);
      fakeSetTimeout(() => deadline.abort(new DOMException("Timed out", "TimeoutError")), delay);
      return deadline.signal;
    });
    try {
      senderReply = () =>
        new Promise((_resolve, reject) => {
          statsSignal!.addEventListener("abort", () => reject(statsSignal!.reason), { once: true });
        });
      if (phase === "established") {
        hook.markFrameDecoded();
        await pollStall(frozenRun(100));
      } else {
        fireTimer(4_000);
        await flush();
        resolveStats(0);
        await flush();
      }
      expect(closed).toBe(0);
      fireTimer(2_000);
      await flush();
      expect(statsSignal?.aborted).toBe(true);
      expect(closed).toBe(1);
      if (phase === "established") expect(updates).toContain(STALLED);
      else expect(failures()).toMatchObject([{ kind: "codec" }]);
    } finally {
      timeout.mockRestore();
    }
  });
}

for (const conflict of [
  { error: "webrtc_stream_changed", message: "The stream changed while WebRTC was starting." },
  { ok: false, code: "session_changed", error: "device session changed from generation 1 to 2" },
]) {
  test(`Android negotiates again after a temporary 409: ${JSON.stringify(conflict)}`, async () => {
    hookOptions = { allowCodecFallback: false, expectContinuousFrames: false };
    await start("visible", 200, false, [Response.json(conflict, { status: 409 })]);
    expect(offersPosted).toBe(1);
    expect(failures()).toEqual([]);
    expect(closed).toBe(0);
    fireTimer(500);
    await flush();
    expect(offersPosted).toBe(2);
    expect(closed).toBe(0);
    expect(failures()).toEqual([]);
  });
}
