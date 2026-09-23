import type { CrashFrame } from "../../crash/report";

export function formatCrashAgo(ms: number | null, now: number): string {
  if (ms === null) return "";
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function crashDetailUrl(listPath: string, id: string, occurrence?: number, key?: number): string {
  const [pathname, search] = listPath.split("?");
  const params = new URLSearchParams(search);
  if (occurrence !== undefined) params.set("occurrence", String(occurrence));
  if (key !== undefined) params.set("key", String(key));
  const qs = params.toString();
  return `${pathname?.replace(/\/+$/, "")}/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`;
}

export type StackRow =
  | { kind: "frame"; index: number; frame: CrashFrame }
  | {
      kind: "collapsed";
      start: number;
      count: number;
      frames: { index: number; frame: CrashFrame }[];
    };

export function collapseSystemFrames(frames: CrashFrame[]): StackRow[] {
  const hasApp = frames.some((frame) => frame.appOwned);
  const hasSystem = frames.some((frame) => !frame.appOwned);
  if (!hasApp || !hasSystem) {
    return frames.map((frame, index) => ({ kind: "frame", index, frame }));
  }

  const rows: StackRow[] = [];
  let index = 0;
  while (index < frames.length) {
    const frame = frames[index]!;
    if (frame.appOwned) {
      rows.push({ kind: "frame", index, frame });
      index += 1;
      continue;
    }

    let end = index;
    while (end < frames.length && !frames[end]!.appOwned) end += 1;

    let start = index;
    if (index === 0) {
      rows.push({ kind: "frame", index: 0, frame: frames[0]! });
      start = 1;
    }

    const hidden = [];
    for (let hiddenIndex = start; hiddenIndex < end; hiddenIndex++) {
      hidden.push({ index: hiddenIndex, frame: frames[hiddenIndex]! });
    }
    if (hidden.length >= 2) {
      rows.push({ kind: "collapsed", start, count: hidden.length, frames: hidden });
    } else {
      for (const item of hidden) rows.push({ kind: "frame", ...item });
    }
    index = end;
  }
  return rows;
}

export function formatOccurrenceClock(ms: number | null, fallback: string): string {
  if (ms === null) return fallback;
  return new Date(ms).toLocaleString();
}

export function crashStreamUrl(path: string, collectTail: boolean): string {
  const url = new URL(path, "http://127.0.0.1");
  url.searchParams.set("tail", collectTail ? "1" : "0");
  return `${url.pathname}${url.search}`;
}
