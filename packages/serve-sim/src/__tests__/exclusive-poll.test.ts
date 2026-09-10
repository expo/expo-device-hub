import { describe, expect, test } from "bun:test";

import { startExclusivePoll } from "../client/utils/exclusive-poll";

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for exclusive poll");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("startExclusivePoll", () => {
  test("does not start another getStats while the previous call is still unresolved", async () => {
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let releaseFirst!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const getStats = async () => {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (started === 1) await firstCall;
      active -= 1;
    };

    const stop = startExclusivePoll(getStats, 5);
    await waitUntil(() => started === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(1);
    expect(maxActive).toBe(1);

    releaseFirst();
    await waitUntil(() => started >= 2);
    stop();
    expect(maxActive).toBe(1);
  });
});
