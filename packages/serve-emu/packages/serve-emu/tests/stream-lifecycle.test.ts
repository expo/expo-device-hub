import { describe, expect, test } from "bun:test";
import {
  StreamSessionResources,
  beginStreamGeneration,
  classifyStreamEventGeneration,
  createStreamLifecycle,
  deriveStreamDisplayStatus,
  gateStreamEventGeneration,
  isCurrentStreamClientEpoch,
  isCurrentStreamGeneration,
  isStreamFatalStatus,
  reduceStreamLifecycle,
  type ClosableStreamFrame,
  type StreamLifecycleState,
} from "../src/ui/lib/stream-lifecycle.ts";

function currentTransition<T extends { type: string }>(
  state: StreamLifecycleState,
  transition: T,
): T & { generation: number; at: number } {
  return { ...transition, generation: state.generation, at: 0 };
}

function renderedLifecycle(): StreamLifecycleState {
  let state = createStreamLifecycle(100);
  state = reduceStreamLifecycle(state, {
    type: "socket-open",
    generation: state.generation,
    at: 110,
  });
  state = reduceStreamLifecycle(state, {
    type: "packet-received",
    generation: state.generation,
    at: 120,
  });
  state = reduceStreamLifecycle(state, {
    type: "decoder-configured",
    generation: state.generation,
    at: 121,
    codec: "avc1.640028",
  });
  state = reduceStreamLifecycle(state, {
    type: "keyframe-submitted",
    generation: state.generation,
    at: 122,
  });
  return reduceStreamLifecycle(state, {
    type: "frame-rendered",
    generation: state.generation,
    at: 130,
  });
}

describe("stream lifecycle generations", () => {
  test("client events require a lifecycle boundary and reject delayed stats", () => {
    expect(classifyStreamEventGeneration(5, 4, false)).toBe("stale");
    expect(classifyStreamEventGeneration(5, 6, false)).toBe(
      "awaiting-boundary",
    );
    expect(classifyStreamEventGeneration(5, 6, true)).toBe(
      "new-generation",
    );
    expect(classifyStreamEventGeneration(6, 6, false)).toBe("current");
    expect(classifyStreamEventGeneration(6, Number.NaN, true)).toBe("invalid");
  });

  test("a reused worker ignores queued stop events until its new connect boundary", () => {
    let gate = { currentGeneration: 8, awaitingConnectBoundary: true };

    let result = gateStreamEventGeneration(gate, 8, "connect");
    expect(result.disposition).toBe("awaiting-boundary");
    gate = result.gate;

    result = gateStreamEventGeneration(gate, 9, "stop");
    expect(result.disposition).toBe("awaiting-boundary");
    gate = result.gate;

    result = gateStreamEventGeneration(gate, 9, null);
    expect(result.disposition).toBe("awaiting-boundary");
    gate = result.gate;

    result = gateStreamEventGeneration(gate, 10, "connect");
    expect(result.disposition).toBe("new-generation");
    expect(result.gate).toEqual({
      currentGeneration: 10,
      awaitingConnectBoundary: false,
    });

    expect(gateStreamEventGeneration(result.gate, 9, null).disposition).toBe(
      "stale",
    );
    expect(gateStreamEventGeneration(result.gate, 10, null).disposition).toBe(
      "current",
    );
  });

  test("a client epoch nonce distinguishes two effects before either sees a generation", () => {
    const previousEffectEpoch = 1;
    const replayedEffectEpoch = 2;
    const queuedOldConnect = {
      clientEpoch: previousEffectEpoch,
      generation: 2,
      reason: "connect" as const,
    };

    expect(
      isCurrentStreamClientEpoch(replayedEffectEpoch, queuedOldConnect.clientEpoch),
    ).toBe(false);
    expect(isCurrentStreamClientEpoch(replayedEffectEpoch, replayedEffectEpoch)).toBe(
      true,
    );
    expect(isCurrentStreamClientEpoch(0, 0)).toBe(false);
    expect(
      gateStreamEventGeneration(
        { currentGeneration: 0, awaitingConnectBoundary: true },
        queuedOldConnect.generation,
        queuedOldConnect.reason,
      ).disposition,
    ).toBe("new-generation");
  });

  test("only terminal worker capability failures persist over lifecycle ticks", () => {
    expect(isStreamFatalStatus("WebCodecs unsupported")).toBe(true);
    expect(isStreamFatalStatus("canvas unavailable")).toBe(true);
    expect(isStreamFatalStatus("decoder error")).toBe(false);
    expect(isStreamFatalStatus("connection error")).toBe(false);
  });

  test("does not report streaming until a current-generation frame is rendered", () => {
    let state = createStreamLifecycle(0);
    expect(deriveStreamDisplayStatus(state, 0)).toBe("connecting");

    state = reduceStreamLifecycle(state, {
      type: "socket-open",
      generation: state.generation,
      at: 10,
    });
    expect(state.phase).toBe("awaiting-keyframe");
    expect(deriveStreamDisplayStatus(state, 20)).toBe("awaiting video");

    state = reduceStreamLifecycle(state, {
      type: "packet-received",
      generation: state.generation,
      at: 30,
    });
    state = reduceStreamLifecycle(state, {
      type: "decoder-configured",
      generation: state.generation,
      at: 31,
      codec: "avc1.640028",
    });
    state = reduceStreamLifecycle(state, {
      type: "keyframe-submitted",
      generation: state.generation,
      at: 32,
    });
    expect(state.phase).toBe("decoding");
    expect(state.rendered).toBe(false);
    expect(deriveStreamDisplayStatus(state, 40)).toBe("decoding video");

    state = reduceStreamLifecycle(state, {
      type: "frame-rendered",
      generation: state.generation,
      at: 50,
    });
    expect(state.phase).toBe("rendered");
    expect(state.lastRenderedAt).toBe(50);
    expect(deriveStreamDisplayStatus(state, 50)).toBe("streaming");
  });

  test("a new generation atomically clears every observable session field", () => {
    const previous = renderedLifecycle();
    const next = beginStreamGeneration(previous, {
      phase: "connecting",
      reason: "reconnect",
      at: 500,
    });

    expect(next).toEqual({
      generation: previous.generation + 1,
      phase: "connecting",
      reason: "reconnect",
      generationStartedAt: 500,
      socketOpenedAt: null,
      lastPacketAt: null,
      lastRenderedAt: null,
      rendered: false,
      codec: null,
    });
    expect(isCurrentStreamGeneration(next, previous.generation)).toBe(false);
    expect(isCurrentStreamGeneration(next, next.generation)).toBe(true);
  });

  test("every socket, session, recovery, and stop boundary starts clean", () => {
    const previous = renderedLifecycle();
    const boundaries = [
      ["connecting", "connect"],
      ["connecting", "reconnect"],
      ["awaiting-keyframe", "video-session"],
      ["recovering", "decoder-recovery"],
      ["disconnected", "disconnect"],
      ["stopped", "stop"],
    ] as const;

    for (const [phase, reason] of boundaries) {
      const next = beginStreamGeneration(previous, { phase, reason, at: 500 });
      expect(next.phase).toBe(phase);
      expect(next.reason).toBe(reason);
      expect(next.rendered).toBe(false);
      expect(next.codec).toBeNull();
      expect(next.lastPacketAt).toBeNull();
      expect(next.lastRenderedAt).toBeNull();
    }
  });

  test("delayed old-generation transitions return the current object unchanged", () => {
    const old = renderedLifecycle();
    const current = beginStreamGeneration(old, {
      phase: "recovering",
      reason: "decoder-recovery",
      at: 1_000,
    });

    const staleRender = reduceStreamLifecycle(current, {
      type: "frame-rendered",
      generation: old.generation,
      at: 1_100,
    });
    const staleCodec = reduceStreamLifecycle(current, {
      type: "decoder-configured",
      generation: old.generation,
      at: 1_100,
      codec: "avc1.stale",
    });

    expect(staleRender).toBe(current);
    expect(staleCodec).toBe(current);
    expect(current.rendered).toBe(false);
    expect(current.codec).toBeNull();
  });

  test("marks an open generation without a first frame as waiting", () => {
    let state = createStreamLifecycle(100);
    state = reduceStreamLifecycle(state, {
      type: "socket-open",
      generation: state.generation,
      at: 200,
    });

    expect(deriveStreamDisplayStatus(state, 5_199)).toBe("awaiting video");
    expect(deriveStreamDisplayStatus(state, 5_200)).toBe("waiting for video");
  });

  test("distinguishes an active decoder stall from a legitimately static stream", () => {
    const staticStream = renderedLifecycle();
    expect(deriveStreamDisplayStatus(staticStream, 20_000)).toBe("streaming");

    const stalled = reduceStreamLifecycle(staticStream, {
      type: "packet-received",
      generation: staticStream.generation,
      at: 6_000,
    });
    expect(deriveStreamDisplayStatus(stalled, 6_100)).toBe("stream stalled");

    // Once the packet source is no longer recent, the timestamps alone cannot
    // distinguish a frozen source from an intentionally static Android screen.
    expect(deriveStreamDisplayStatus(stalled, 9_000)).toBe("streaming");
  });

  test("reports packets-without-output as stalled after the first-frame deadline", () => {
    let state = createStreamLifecycle(0);
    state = reduceStreamLifecycle(state, {
      type: "socket-open",
      generation: state.generation,
      at: 10,
    });
    state = reduceStreamLifecycle(state, {
      type: "keyframe-submitted",
      generation: state.generation,
      at: 5_100,
    });

    expect(deriveStreamDisplayStatus(state, 5_200)).toBe("stream stalled");
  });

  test("maps boundary phases without inheriting prior rendered state", () => {
    const rendered = renderedLifecycle();
    const recovering = beginStreamGeneration(rendered, {
      phase: "recovering",
      reason: "decoder-recovery",
      at: 200,
    });
    const disconnected = beginStreamGeneration(recovering, {
      phase: "disconnected",
      reason: "disconnect",
      at: 300,
    });
    const stopped = beginStreamGeneration(disconnected, {
      phase: "stopped",
      reason: "stop",
      at: 400,
    });

    expect(deriveStreamDisplayStatus(recovering, 200)).toBe("recovering video");
    expect(deriveStreamDisplayStatus(disconnected, 300)).toBe("disconnected");
    expect(deriveStreamDisplayStatus(stopped, 400)).toBe("stopped");
    expect(stopped.rendered).toBe(false);
  });

  test("recovery cannot remain optimistic forever without a rendered frame", () => {
    const old = renderedLifecycle();
    const recovering = beginStreamGeneration(old, {
      phase: "recovering",
      reason: "decoder-recovery",
      at: 1_000,
    });

    expect(deriveStreamDisplayStatus(recovering, 5_999)).toBe("recovering video");
    expect(deriveStreamDisplayStatus(recovering, 6_000)).toBe("waiting for video");

    const receivingDeltas = reduceStreamLifecycle(recovering, {
      type: "packet-received",
      generation: recovering.generation,
      at: 5_900,
    });
    expect(deriveStreamDisplayStatus(receivingDeltas, 6_000)).toBe("stream stalled");
  });

  test("keeps timestamps monotonic within a generation", () => {
    let state = createStreamLifecycle(100);
    state = reduceStreamLifecycle(state, {
      type: "packet-received",
      generation: state.generation,
      at: 200,
    });
    state = reduceStreamLifecycle(state, {
      type: "packet-received",
      generation: state.generation,
      at: 150,
    });
    state = reduceStreamLifecycle(state, {
      type: "frame-rendered",
      generation: state.generation,
      at: 90,
    });

    expect(state.lastPacketAt).toBe(200);
    expect(state.lastRenderedAt).toBe(100);
  });

  test("supports deterministic custom status thresholds", () => {
    let state = createStreamLifecycle(0);
    state = reduceStreamLifecycle(
      state,
      currentTransition(state, { type: "socket-open" }),
    );
    expect(
      deriveStreamDisplayStatus(state, 10, {
        waitingMs: 10,
        stallMs: 20,
        packetFreshMs: 5,
      }),
    ).toBe("waiting for video");
    expect(() => deriveStreamDisplayStatus(state, 10, { waitingMs: -1 })).toThrow(
      "waitingMs",
    );
  });
});

class FakeFrame implements ClosableStreamFrame {
  closeCalls = 0;

  constructor(
    readonly timestamp: number,
    private readonly throwOnClose = false,
  ) {}

  close(): void {
    this.closeCalls += 1;
    if (this.throwOnClose) throw new Error("fake close failed");
  }
}

describe("StreamSessionResources", () => {
  test("closes the oldest frame and removes its timing on overflow", () => {
    const resources = new StreamSessionResources<FakeFrame, string>({
      frameCapacity: 2,
      timingCapacity: 8,
    });
    const first = new FakeFrame(1);
    const second = new FakeFrame(2);
    const third = new FakeFrame(3);
    for (const frame of [first, second, third]) {
      resources.rememberTiming(frame.timestamp, `timing-${frame.timestamp}`);
      resources.pushFrame(frame);
    }

    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(0);
    expect(third.closeCalls).toBe(0);
    expect(resources.queuedFrameCount).toBe(2);
    expect(resources.timingCount).toBe(2);
    expect(resources.takeTiming(1)).toBeUndefined();
  });

  test("transfers the newest frame while closing every superseded frame", () => {
    const resources = new StreamSessionResources<FakeFrame, string>({ frameCapacity: 3 });
    const frames = [new FakeFrame(10), new FakeFrame(11), new FakeFrame(12)];
    for (const frame of frames) {
      resources.rememberTiming(frame.timestamp, `timing-${frame.timestamp}`);
      resources.pushFrame(frame);
    }

    const latest = resources.takeLatestFrame();

    expect(latest).toBe(frames[2]);
    expect(frames.map((frame) => frame.closeCalls)).toEqual([1, 1, 0]);
    expect(resources.queuedFrameCount).toBe(0);
    expect(resources.timingCount).toBe(1);
    expect(resources.takeTiming(12)).toBe("timing-12");
  });

  test("reset closes all queued frames exactly once and clears every timing", () => {
    const resources = new StreamSessionResources<FakeFrame, { receivedAt: number }>();
    const frames = [new FakeFrame(20), new FakeFrame(21), new FakeFrame(22)];
    for (const frame of frames) {
      resources.rememberTiming(frame.timestamp, { receivedAt: frame.timestamp });
      resources.pushFrame(frame);
    }
    resources.rememberTiming(99, { receivedAt: 99 });

    expect(resources.reset()).toEqual({ closedFrames: 3, clearedTimings: 4 });
    expect(frames.map((frame) => frame.closeCalls)).toEqual([1, 1, 1]);
    expect(resources.queuedFrameCount).toBe(0);
    expect(resources.timingCount).toBe(0);

    expect(resources.reset()).toEqual({ closedFrames: 0, clearedTimings: 0 });
    expect(frames.map((frame) => frame.closeCalls)).toEqual([1, 1, 1]);
  });

  test("one frame throwing during close cannot interrupt generation cleanup", () => {
    const resources = new StreamSessionResources<FakeFrame, number>();
    const broken = new FakeFrame(30, true);
    const healthy = new FakeFrame(31);
    resources.pushFrame(broken);
    resources.pushFrame(healthy);
    resources.rememberTiming(30, 1);
    resources.rememberTiming(31, 2);

    expect(resources.reset()).toEqual({ closedFrames: 2, clearedTimings: 2 });
    expect(broken.closeCalls).toBe(1);
    expect(healthy.closeCalls).toBe(1);
  });

  test("bounds timing entries independently of decoded-frame capacity", () => {
    const resources = new StreamSessionResources<FakeFrame, string>({ timingCapacity: 2 });
    resources.rememberTiming(1, "one");
    resources.rememberTiming(2, "two");
    resources.rememberTiming(3, "three");

    expect(resources.timingCount).toBe(2);
    expect(resources.takeTiming(1)).toBeUndefined();
    expect(resources.takeTiming(2)).toBe("two");
    expect(resources.takeTiming(3)).toBe("three");
  });

  test("refreshes an existing timing key without growing the map", () => {
    const resources = new StreamSessionResources<FakeFrame, string>({ timingCapacity: 2 });
    resources.rememberTiming(1, "old");
    resources.rememberTiming(2, "two");
    resources.rememberTiming(1, "new");
    resources.rememberTiming(3, "three");

    expect(resources.takeTiming(2)).toBeUndefined();
    expect(resources.takeTiming(1)).toBe("new");
    expect(resources.takeTiming(3)).toBe("three");
  });

  test("rejects invalid capacities and timestamps", () => {
    expect(() => new StreamSessionResources({ frameCapacity: 0 })).toThrow("frameCapacity");
    expect(() => new StreamSessionResources({ timingCapacity: 1.5 })).toThrow("timingCapacity");
    const resources = new StreamSessionResources<FakeFrame, string>();
    expect(() => resources.rememberTiming(Number.NaN, "bad")).toThrow("frame timestamp");
    expect(() => resources.pushFrame(new FakeFrame(Number.POSITIVE_INFINITY))).toThrow(
      "frame timestamp",
    );
  });
});
