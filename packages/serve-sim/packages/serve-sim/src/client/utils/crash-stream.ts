import type { CrashStreamFrame } from "../../crash/protocol";
import type { CrashMeta } from "../../crash/runtime";
import type { CrashSummary } from "../../crash/store";

export type CrashListState = { meta: CrashMeta | null; crashes: CrashSummary[]; ready: boolean };

export const EMPTY_CRASH_LIST: CrashListState = { meta: null, crashes: [], ready: false };

export function parseCrashFrame(data: string): CrashStreamFrame | null {
  let parsed: CrashStreamFrame;
  try {
    parsed = JSON.parse(data) as CrashStreamFrame;
  } catch {
    return null;
  }
  switch (parsed?.type) {
    case "meta":
      return parsed;
    case "list":
      return Array.isArray(parsed.crashes) ? parsed : null;
    case "crash":
    case "recurred":
      return parsed.record ? parsed : null;
    case "evicted":
      return typeof parsed.id === "string" ? parsed : null;
    default:
      return null;
  }
}

// Two signatures can land in the same millisecond, so the tiebreak keeps a reconnect's list
// in the order the live frames built.
const byNewest = (a: CrashSummary, b: CrashSummary): number =>
  b.lastSeen - a.lastSeen || b.firstSeen - a.firstSeen || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1);

export function applyCrashFrame(state: CrashListState, frame: CrashStreamFrame): CrashListState {
  switch (frame.type) {
    case "meta":
      return { ...state, meta: frame.meta };
    case "list":
      return { ...state, ready: true, crashes: [...frame.crashes].sort(byNewest) };
    case "evicted":
      return { ...state, crashes: state.crashes.filter((crash) => crash.id !== frame.id) };
    case "crash":
    case "recurred":
      return {
        ...state,
        crashes: [
          frame.record,
          ...state.crashes.filter((crash) => crash.id !== frame.record.id),
        ].sort(byNewest),
      };
    default:
      return state;
  }
}
