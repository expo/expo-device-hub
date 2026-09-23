import { describe, expect, test } from "bun:test";
import { logWindow } from "../client/utils/logs-window";

describe("logWindow", () => {
  test("returns an empty range when there are no rows", () => {
    expect(logWindow(0, 0, 200)).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0,
      total: 0,
    });
  });

  test("windows a long list to the viewport plus overscan", () => {
    const win = logWindow(2000, 440, 220, null, 22, 18, 2);
    expect(win.total).toBe(44_000);
    expect(win.end - win.start).toBeLessThan(30);
    expect(win.start).toBeGreaterThan(0);
    expect(win.end).toBeLessThan(2000);
    expect(win.padTop + (win.end - win.start) * 22 + win.padBottom).toBe(win.total);
  });

  test("accounts for one expanded row in the scroll height", () => {
    const collapsed = logWindow(10, 0, 100, null, 22, 18, 0);
    const expanded = logWindow(10, 0, 100, 3, 22, 18, 0);
    expect(expanded.total).toBe(collapsed.total + 18);
  });
});
