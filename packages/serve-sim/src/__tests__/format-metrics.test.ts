import { describe, expect, it } from "bun:test";

import { formatCpu, formatMem, formatRate, sparklinePath } from "../client/utils/format-metrics";

describe("formatCpu", () => {
  it("rounds to a whole percent (per-core, can exceed 100)", () => {
    expect(formatCpu(16.5)).toBe("17%");
    expect(formatCpu(0)).toBe("0%");
    expect(formatCpu(240.2)).toBe("240%");
  });
});

describe("formatMem", () => {
  it("renders bytes as whole MB below 1 GB", () => {
    expect(formatMem(176 * 1024 * 1024)).toBe("176 MB");
    expect(formatMem(0)).toBe("0 MB");
  });

  it("switches to GB at 1024 MB and up", () => {
    expect(formatMem(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatMem(1536 * 1024 * 1024)).toBe("1.5 GB");
  });
});

describe("formatRate", () => {
  it("renders B/s below 1 KB/s", () => {
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(512)).toBe("512 B/s");
    expect(formatRate(1023)).toBe("1023 B/s");
  });

  it("switches to KB/s at 1024 B/s", () => {
    expect(formatRate(1024)).toBe("1 KB/s");
  });

  it("switches to MB/s at 1 MB/s", () => {
    expect(formatRate(1024 * 1024)).toBe("1.0 MB/s");
    expect(formatRate(5 * 1024 * 1024)).toBe("5.0 MB/s");
  });

  it("rounds within a unit rather than promoting near a boundary (matches formatMem)", () => {
    expect(formatRate(1023.6 * 1024)).toBe("1024 KB/s");
  });

  it("clamps non-finite and negative input to zero", () => {
    expect(formatRate(Number.NaN)).toBe("0 B/s");
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe("0 B/s");
    expect(formatRate(-100)).toBe("0 B/s");
  });
});

describe("sparklinePath", () => {
  it("returns empty for fewer than two points", () => {
    expect(sparklinePath([], 100, 20)).toBe("");
    expect(sparklinePath([5], 100, 20)).toBe("");
  });

  it("interpolates the data points with smooth curves spanning the box", () => {
    const d = sparklinePath([0, 5, 10], 100, 20);
    // Passes through the first (peak scaled to bottom) and last (to top) points.
    expect(d.startsWith("M0.0,20.0")).toBe(true);
    expect(d.endsWith("100.0,0.0")).toBe(true);
    // Curved, not straight segments.
    expect(d).toContain(" C");
    expect(d).not.toContain(" L");
  });

  it("never overshoots a segment's height range (no invented peaks)", () => {
    // Monotonically rising values → every y stays within [0, height], so the
    // curve never dips below or bulges above what the data actually shows.
    const d = sparklinePath([1, 2, 3, 4, 5], 100, 20);
    const ys = [...d.matchAll(/,(\d+\.\d+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(20);
  });

  it("scales against sharedMax when provided", () => {
    // Peak is 5, but sharedMax 10 → last point sits at half height, not the top.
    const d = sparklinePath([0, 5], 100, 20, 10);
    expect(d.endsWith("100.0,10.0")).toBe(true);
  });
});
