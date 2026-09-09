import { describe, expect, test } from "bun:test";
import {
  createLatestAnimationFrameScheduler,
  findAccessibilityNodeAt,
  measureAccessibilityViewport,
  type AccessibilityHitTarget,
} from "../src/ui/lib/accessibility-hover.ts";

function node(
  id: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
): AccessibilityHitTarget {
  return { id, bounds: { left, top, right, bottom } };
}

describe("accessibility hover hit testing", () => {
  test("selects the minimum-area containing node without changing input order", () => {
    const nodes = [
      node("screen", 0, 0, 1000, 2000),
      node("card", 100, 300, 900, 900),
      node("button", 300, 500, 700, 700),
      node("same-area-later", 300, 500, 700, 700),
    ];
    const originalOrder = nodes.map(({ id }) => id);

    expect(findAccessibilityNodeAt(nodes, { x: 0.5, y: 0.3 }, { width: 1000, height: 2000 })?.id)
      .toBe("button");
    expect(nodes.map(({ id }) => id)).toEqual(originalOrder);
  });

  test("keeps inclusive edge behavior and returns null outside every node", () => {
    const nodes = [node("target", 100, 200, 300, 400)];
    const viewport = { width: 1000, height: 1000 };

    expect(findAccessibilityNodeAt(nodes, { x: 0.1, y: 0.2 }, viewport)?.id).toBe("target");
    expect(findAccessibilityNodeAt(nodes, { x: 0.3, y: 0.4 }, viewport)?.id).toBe("target");
    expect(findAccessibilityNodeAt(nodes, { x: 0.301, y: 0.4 }, viewport)).toBeNull();
  });

  test("measures snapshot bounds only when the snapshot changes", () => {
    expect(measureAccessibilityViewport([], null)).toBeNull();
    expect(measureAccessibilityViewport([], { width: 1080, height: 2400 })).toEqual({
      width: 1080,
      height: 2400,
    });
    expect(
      measureAccessibilityViewport(
        [node("overscan", 0, 0, 1440, 2600)],
        { width: 1080, height: 2400 },
      ),
    ).toEqual({ width: 1440, height: 2600 });
  });

  test("visits a representative 50k-node snapshot exactly once", () => {
    let boundsReads = 0;
    const nodes = Array.from({ length: 50_000 }, (_, index): AccessibilityHitTarget => ({
      id: String(index),
      get bounds() {
        boundsReads += 1;
        const inset = index % 400;
        return { left: inset, top: inset, right: 2000 - inset, bottom: 2000 - inset };
      },
    }));

    const match = findAccessibilityNodeAt(nodes, { x: 0.5, y: 0.5 }, { width: 2000, height: 2000 });

    expect(match?.id).toBe("399");
    expect(boundsReads).toBe(nodes.length);
  });
});

describe("latest animation-frame scheduling", () => {
  test("coalesces a pointer burst and delivers only its newest sample", () => {
    let requested = 0;
    const callbacks = new Map<number, (timestamp: number) => void>();
    const delivered: number[] = [];
    const scheduler = createLatestAnimationFrameScheduler(
      (value: number) => delivered.push(value),
      (callback) => {
        const handle = ++requested;
        callbacks.set(handle, callback);
        return handle;
      },
      (handle) => callbacks.delete(handle),
    );

    for (let index = 0; index < 10_000; index += 1) scheduler.schedule(index);

    expect(requested).toBe(1);
    expect(delivered).toEqual([]);
    callbacks.get(1)?.(16);
    expect(delivered).toEqual([9_999]);
    expect(scheduler.hasPending()).toBe(false);

    scheduler.schedule(10_000);
    expect(requested).toBe(2);
    callbacks.get(2)?.(32);
    expect(delivered).toEqual([9_999, 10_000]);
  });

  test("limits a 20k-node hit test to one scan for each pointer frame", () => {
    let scheduledCallback: ((timestamp: number) => void) | undefined;
    let boundsReads = 0;
    let hitTests = 0;
    const nodes = Array.from({ length: 20_000 }, (_, index): AccessibilityHitTarget => ({
      id: String(index),
      get bounds() {
        boundsReads += 1;
        return { left: 0, top: 0, right: 1080 - (index % 500), bottom: 2400 };
      },
    }));
    const scheduler = createLatestAnimationFrameScheduler(
      (x: number) => {
        hitTests += 1;
        findAccessibilityNodeAt(nodes, { x, y: 0.5 }, { width: 1080, height: 2400 });
      },
      (callback) => {
        scheduledCallback = callback;
        return 1;
      },
      () => {
        scheduledCallback = undefined;
      },
    );

    for (let move = 0; move < 240; move += 1) scheduler.schedule(move / 240);
    expect(hitTests).toBe(0);
    expect(boundsReads).toBe(0);

    scheduledCallback?.(16);
    expect(hitTests).toBe(1);
    expect(boundsReads).toBe(nodes.length);
  });

  test("flush and cancel release pending pointer work", () => {
    const delivered: string[] = [];
    const canceled: number[] = [];
    const callbacks = new Map<number, (timestamp: number) => void>();
    let nextHandle = 0;
    const scheduler = createLatestAnimationFrameScheduler(
      (value: string) => delivered.push(value),
      (callback) => {
        const handle = ++nextHandle;
        callbacks.set(handle, callback);
        return handle;
      },
      (handle) => {
        canceled.push(handle);
        callbacks.delete(handle);
      },
    );

    scheduler.schedule("move");
    scheduler.flush();
    expect(delivered).toEqual(["move"]);
    expect(canceled).toEqual([1]);

    scheduler.schedule("stale-hover");
    scheduler.cancel();
    expect(delivered).toEqual(["move"]);
    expect(canceled).toEqual([1, 2]);
    expect(scheduler.hasPending()).toBe(false);
  });
});
