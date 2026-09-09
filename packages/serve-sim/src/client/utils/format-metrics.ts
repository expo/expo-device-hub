/** Format a CPU percentage as a rounded whole-number string (e.g. "42%"). */
export function formatCpu(cpuPct: number): string {
  return `${Math.round(cpuPct)}%`;
}

/** Format a byte count as MB, switching to GB past 1024 MB. */
export function formatMem(memBytes: number): string {
  const mb = memBytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Format a per-second byte rate (e.g. "0 B/s", "12 KB/s", "1.2 MB/s"); non-finite or negative input renders as "0 B/s". */
export function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0 B/s";
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  const kb = bytesPerSec / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB/s` : `${(kb / 1024).toFixed(1)} MB/s`;
}

/**
 * Smooth sparkline path, auto-scaled to the window peak. Catmull-Rom spline with
 * control points clamped per segment so the curve never overshoots the data. Pass `sharedMax` to
 * scale several series against one peak (e.g. the download/upload pair) so their heights compare.
 */
export function sparklinePath(
  values: number[],
  width: number,
  height: number,
  sharedMax?: number,
): string {
  if (values.length < 2) return "";
  const max = sharedMax !== undefined && sharedMax > 0 ? sharedMax : Math.max(...values, 1);
  const stepX = width / (values.length - 1);
  const pts = values.map((v, i) => ({ x: i * stepX, y: height - (v / max) * height }));

  let d = `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const lo = Math.min(p1.y, p2.y);
    const hi = Math.max(p1.y, p2.y);
    const clampY = (y: number) => Math.min(hi, Math.max(lo, y));
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}
