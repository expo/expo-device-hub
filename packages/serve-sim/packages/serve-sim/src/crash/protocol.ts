import type { CrashMeta } from "./runtime";
import type { CrashOccurrence, CrashRecord, CrashSummary } from "./store";

export type CrashStreamFrame =
  | { type: "meta"; meta: CrashMeta }
  | { type: "list"; crashes: CrashSummary[] }
  | { type: "crash" | "recurred"; record: CrashSummary }
  | { type: "evicted"; id: string };

export function summarizeCrash(record: CrashRecord): CrashSummary {
  const { frames: _frames, occurrences, ...rest } = record;
  const newest = occurrences[occurrences.length - 1];
  return {
    ...rest,
    logTailLines: newest?.logTail.length ?? 0,
    occurrenceCount: occurrences.length,
    occurrenceTimes: occurrences.map((item) => ({
      key: item.key,
      capturedAtMs: item.capturedAtMs,
      capturedAt: item.capturedAt,
      rawPath: item.rawPath,
    })),
  };
}

export type SelectedOccurrence = CrashOccurrence & { index: number; total: number };
export type CrashDetailResponse = {
  record: CrashSummary;
  occurrence: SelectedOccurrence;
  report: string | null;
  reportError: string | null;
};
