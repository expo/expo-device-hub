import { describe, expect, test } from "bun:test";
import {
  applyFullscreenSearch,
  escapeKeyOutcome,
  isPresentationCorner,
  nearestCorner,
  presentationCornerStyle,
  presentationExitOffset,
  presentationModeFromSearch,
} from "../client/utils/presentation";

describe("presentationModeFromSearch", () => {
  test("is off by default", () => {
    expect(presentationModeFromSearch("")).toEqual({ initial: false, embedLocked: false });
    expect(presentationModeFromSearch("?device=udid")).toEqual({ initial: false, embedLocked: false });
  });

  test("enters presentation from fullscreen=1", () => {
    expect(presentationModeFromSearch("?fullscreen=1")).toEqual({
      initial: true,
      embedLocked: false,
    });
  });

  test("ignores fullscreen=true", () => {
    expect(presentationModeFromSearch("?fullscreen=true")).toEqual({
      initial: false,
      embedLocked: false,
    });
  });

  test("locks presentation for embed=1", () => {
    expect(presentationModeFromSearch("?embed=1&device=udid")).toEqual({
      initial: true,
      embedLocked: true,
    });
  });
});

describe("applyFullscreenSearch", () => {
  test("sets and clears the fullscreen flag without dropping other params", () => {
    const withFlag = applyFullscreenSearch("https://sim.local/?device=udid", true);
    expect(withFlag).toContain("fullscreen=1");
    expect(withFlag).toContain("device=udid");

    const cleared = applyFullscreenSearch(withFlag, false);
    expect(cleared).not.toContain("fullscreen");
    expect(cleared).toContain("device=udid");
  });

  test("does not rewrite an embed URL", () => {
    const href = "https://sim.local/?embed=1&device=udid";
    expect(applyFullscreenSearch(href, false)).toBe(href);
    expect(applyFullscreenSearch(href, true)).toBe(href);
  });
});

describe("escapeKeyOutcome", () => {
  const down = { type: "keydown", repeat: false } as const;
  const heldDown = { type: "keydown", repeat: true } as const;
  const up = { type: "keyup", repeat: false } as const;

  test("ignores Escape outside presentation so the simulator still receives it", () => {
    expect(escapeKeyOutcome(down, { presentation: false, swallowing: false })).toEqual({
      swallow: false,
      exit: false,
      swallowing: false,
    });
  });

  test("exits once per press and swallows the whole press", () => {
    const pressed = escapeKeyOutcome(down, { presentation: true, swallowing: false });
    expect(pressed).toEqual({ swallow: true, exit: true, swallowing: true });

    const repeated = escapeKeyOutcome(heldDown, { presentation: false, swallowing: true });
    expect(repeated).toEqual({ swallow: true, exit: false, swallowing: true });

    const released = escapeKeyOutcome(up, { presentation: false, swallowing: true });
    expect(released).toEqual({ swallow: true, exit: false, swallowing: false });
  });

  test("does not exit twice while the key is held down inside presentation", () => {
    expect(escapeKeyOutcome(heldDown, { presentation: true, swallowing: true }).exit).toBe(false);
  });

  test("swallows the orphaned keyup, then releases its hold", () => {
    const released = escapeKeyOutcome(up, { presentation: false, swallowing: true });

    expect(released.swallow).toBe(true);
    expect(released.swallowing).toBe(false);
    expect(escapeKeyOutcome(down, { presentation: false, swallowing: false }).swallow).toBe(false);
  });
});

describe("presentationExitOffset", () => {
  test("sits at the corner when the device leaves room beside it", () => {
    expect(presentationExitOffset({ side: 412, top: 0 })).toEqual({ top: 12, right: 12 });
  });

  test("drops into the gap above a full-width device", () => {
    // 430x932 viewport, device 430x860.
    const { top } = presentationExitOffset({ side: 0, top: 36 });

    expect(top).toBe(2);
    expect(top + 34).toBeLessThanOrEqual(36);
  });

  test("never leaves the viewport when neither gutter fits", () => {
    expect(presentationExitOffset({ side: 0, top: 10 })).toEqual({ top: 0, right: 12 });
  });
});

describe("presentation corner placement", () => {
  const viewport = { width: 400, height: 800 };

  test("snaps to the corner the drag ended nearest", () => {
    expect(nearestCorner(390, 10, viewport)).toBe("top-right");
    expect(nearestCorner(10, 10, viewport)).toBe("top-left");
    expect(nearestCorner(390, 790, viewport)).toBe("bottom-right");
    expect(nearestCorner(10, 790, viewport)).toBe("bottom-left");
  });

  test("anchors to the dragged-to edges, reusing the gutter offsets", () => {
    const gutters = { side: 412, top: 0 };
    const topRight = presentationCornerStyle("top-right", gutters);
    const bottomLeft = presentationCornerStyle("bottom-left", gutters);

    expect(topRight).toEqual({ top: 12, right: 12 });
    expect(bottomLeft).toEqual({ bottom: 12, left: 12 });
  });

  test("rejects anything that isn't a corner, so stored junk can't strand it", () => {
    expect(isPresentationCorner("top-left")).toBe(true);
    expect(isPresentationCorner("middle")).toBe(false);
    expect(isPresentationCorner(null)).toBe(false);
  });
});
