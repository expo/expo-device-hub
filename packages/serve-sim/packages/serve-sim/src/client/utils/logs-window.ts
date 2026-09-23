export const LOG_ROW_HEIGHT = 22;
export const LOG_ROW_EXPAND_EXTRA = 18;
export const LOG_ROW_OVERSCAN = 16;

export function logWindow(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  expandedIndex: number | null = null,
  rowHeight = LOG_ROW_HEIGHT,
  extraHeight = LOG_ROW_EXPAND_EXTRA,
  overscan = LOG_ROW_OVERSCAN
): { start: number; end: number; padTop: number; padBottom: number; total: number } {
  const extra =
    expandedIndex !== null && expandedIndex >= 0 && expandedIndex < count ? extraHeight : 0;
  const total = count * rowHeight + extra;
  if (count === 0 || viewportHeight <= 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0, total };
  }

  const top = Math.max(0, scrollTop);
  let start = Math.floor(top / rowHeight);
  if (extra > 0 && expandedIndex !== null && start > expandedIndex) {
    start = Math.floor((top - extra) / rowHeight);
  }
  start = Math.max(0, Math.min(count - 1, start - overscan));

  let end = Math.ceil((top + viewportHeight) / rowHeight) + overscan;
  if (extra > 0 && expandedIndex !== null && expandedIndex < end) {
    end = Math.ceil((top + viewportHeight - extra) / rowHeight) + overscan;
  }
  end = Math.min(count, Math.max(start + 1, end));

  const padTop = start * rowHeight + (extra > 0 && expandedIndex !== null && start > expandedIndex ? extra : 0);
  const last = end - 1;
  const lastBottom =
    (last + 1) * rowHeight + (extra > 0 && expandedIndex !== null && last >= expandedIndex ? extra : 0);
  return { start, end, padTop, padBottom: Math.max(0, total - lastBottom), total };
}
