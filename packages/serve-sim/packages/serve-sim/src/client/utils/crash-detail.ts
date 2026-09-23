import type { CrashDetailResponse } from "../../crash/protocol";
import type { CrashSummary } from "../../crash/store";

export type CrashDetailState = {
  detail: CrashDetailResponse | null;
  pendingIndex: number | null;
  error: string | null;
};
export const EMPTY_CRASH_DETAIL: CrashDetailState = { detail: null, pendingIndex: null, error: null };
type LoadDetail = (
  id: string,
  occurrence: number | undefined,
  signal: AbortSignal,
  key?: number
) => Promise<CrashDetailResponse>;

export function createCrashDetailController(loadDetail: LoadDetail, onChange: (state: CrashDetailState) => void) {
  let state = EMPTY_CRASH_DETAIL;
  let crashes: CrashSummary[] = [];
  let request: AbortController | null = null;
  let generation = 0;
  let reloadedFor: number | null = null;

  const publish = (next: CrashDetailState): void => {
    state = next;
    onChange(next);
  };
  const cancel = (): void => {
    generation += 1;
    request?.abort();
    request = null;
  };

  const load = async (id: string, occurrence?: number, key?: number): Promise<void> => {
    cancel();
    const epoch = generation;
    const controller = new AbortController();
    request = controller;
    publish({ ...state, pendingIndex: occurrence ?? null, error: null });
    try {
      const detail = await loadDetail(id, occurrence, controller.signal, key);
      if (epoch !== generation) return;
      publish({ detail, pendingIndex: detail.occurrence.index, error: null });
      sync(crashes);
    } catch {
      if (epoch !== generation) return;
      publish({
        ...state,
        pendingIndex: state.detail?.occurrence.index ?? null,
        error: "Could not load that crash. Try selecting it again.",
      });
    } finally {
      if (request === controller) request = null;
    }
  };

  function sync(nextCrashes: CrashSummary[]): void {
    crashes = nextCrashes;
    const detail = state.detail;
    if (!detail) return;
    const listed = crashes.find((crash) => crash.id === detail.record.id);
    if (!listed) return;
    const index = listed.occurrenceTimes.findIndex((stamp) => stamp.key === detail.occurrence.key);
    if (index === -1) {
      if (listed.count < detail.record.count) return;
      if (reloadedFor === detail.occurrence.key) return;
      reloadedFor = detail.occurrence.key;
      void load(detail.record.id, listed.occurrenceCount - 1);
      return;
    }
    if (
      listed.count === detail.record.count &&
      index === detail.occurrence.index &&
      listed.occurrenceCount === detail.occurrence.total
    ) return;
    publish({
      ...state,
      pendingIndex: state.pendingIndex === detail.occurrence.index ? index : state.pendingIndex,
      detail: {
        ...detail,
        record: listed,
        occurrence: { ...detail.occurrence, index, total: listed.occurrenceCount },
      },
    });
  }

  const select = (index: number): boolean => {
    const detail = state.detail;
    if (!detail || index < 0 || index >= detail.occurrence.total || index === state.pendingIndex) return false;
    void load(detail.record.id, index, detail.record.occurrenceTimes[index]?.key);
    return true;
  };

  return {
    load,
    sync,
    select,
    step: (delta: number): boolean => select((state.pendingIndex ?? state.detail?.occurrence.index ?? 0) + delta),
    close: (): void => {
      cancel();
      reloadedFor = null;
      publish(EMPTY_CRASH_DETAIL);
    },
    dispose: cancel,
    snapshot: (): CrashDetailState => state,
  };
}
