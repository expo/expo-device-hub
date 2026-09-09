import { describe, expect, test } from "bun:test";
import { DEFAULT_HOST } from "../src/server.ts";
import {
  frameDeliveryDecision,
  sendResultDecision,
} from "../src/server/backpressure.ts";
import {
  StaleSessionError,
  sessionScoped,
  sessionScopedCommit,
  sessionScopedResult,
} from "../src/server/session-scope.ts";

describe("server module", () => {
  test("remains importable without opening Android or a port", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });
});

describe("server backpressure policy", () => {
  const base = {
    awaitingKeyFrame: false,
    isKeyFrame: false,
    bufferedBytes: 0,
    dropThresholdBytes: 512,
    closeThresholdBytes: 16_384,
  };

  test("drops deltas until a keyframe and prioritizes the close threshold", () => {
    expect(
      frameDeliveryDecision({ ...base, awaitingKeyFrame: true }),
    ).toBe("drop-awaiting-keyframe");
    expect(
      frameDeliveryDecision({
        ...base,
        awaitingKeyFrame: true,
        isKeyFrame: true,
      }),
    ).toBe("send");
    expect(
      frameDeliveryDecision({ ...base, bufferedBytes: 513 }),
    ).toBe("drop-buffered");
    expect(
      frameDeliveryDecision({ ...base, bufferedBytes: 16_385 }),
    ).toBe("close-slow-client");
    expect(
      frameDeliveryDecision({
        ...base,
        awaitingKeyFrame: true,
        bufferedBytes: 16_385,
      }),
    ).toBe("close-slow-client");
  });

  test("classifies Bun WebSocket send results", () => {
    expect(sendResultDecision(-1)).toBe("backpressure");
    expect(sendResultDecision(0)).toBe("closed");
    expect(sendResultDecision(1)).toBe("sent");
  });
});

describe("device-session isolation", () => {
  test("a replay callback cannot cross a session generation", async () => {
    let generation = 4;
    const calls: string[] = [];
    const action = sessionScoped(4, () => generation, async (value: string) => {
      calls.push(value);
    });

    await action("old-session");
    generation++;
    expect(() => action("new-session")).toThrow(StaleSessionError);
    expect(calls).toEqual(["old-session"]);
  });

  test("an in-flight result cannot commit after a device switch", async () => {
    let generation = 10;
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    let committed: string | null = null;
    const work = sessionScopedResult(10, () => generation, () => pending)
      .then((value) => {
        committed = value;
      });

    generation++;
    resolve("old-device-location");
    await expect(work).rejects.toBeInstanceOf(StaleSessionError);
    expect(committed).toBeNull();
  });

  test("the post-await check and state commit are one synchronous step", async () => {
    let generation = 20;
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const commits: string[] = [];
    const work = sessionScopedCommit(
      20,
      () => generation,
      () => pending,
      (value) => {
        commits.push(value);
        return value.length;
      },
    );

    generation++;
    resolve("stale");
    await expect(work).rejects.toBeInstanceOf(StaleSessionError);
    expect(commits).toEqual([]);
  });
});
