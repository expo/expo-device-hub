import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  gridCatalogNeedsRefresh,
  mergeGridCatalog,
  type GridCatalogDevice,
  type GridCatalogResponse,
  type GridDeviceStatus,
  type GridStatusResponse,
} from "../utils/grid";
import { openHostEventStream } from "../utils/exec";

/** Devices fetched up front; the long tail loads as the sidebar scrolls. */
const DEFAULT_PAGE_SIZE = 60;
/** Upper bound matching the server's clamp — one request covers any catalog. */
const LOAD_ALL_LIMIT = 1000;
/** Slow repair for runtime/device additions that happen outside this page. */
const CATALOG_RECOVERY_INTERVAL_MS = 60_000;

function withGridQuery(
  endpoint: string,
  values: Record<string, string | number | null | undefined>,
): string {
  const url = new URL(endpoint, window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value == null || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Fetches the static grid device catalog with server-side pagination. The most relevant
 * devices (streaming → booted → last-opened) sort first, so the initial page is
 * the useful one; `loadMore`/`loadAll` grow the window. Live state arrives over
 * a compact, change-only event feed and is merged into the cached descriptors.
 *
 * `limit` is always requested from offset 0 (not a sliding window). If a status
 * reorder moves a device from outside the loaded page into that window, only
 * then do we refresh the catalog page to obtain its static metadata.
 */
export function useGridDevices(
  catalogEndpoint: string | undefined,
  statusEventsEndpoint: string | undefined,
  enabled: boolean,
  selectedUdid: string | null,
  pageSize: number = DEFAULT_PAGE_SIZE,
) {
  const [catalog, setCatalog] = useState<GridCatalogDevice[] | null>(null);
  const [statuses, setStatuses] = useState<GridDeviceStatus[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(pageSize);
  const [refreshKey, setRefreshKey] = useState(0);
  const selectedUdidRef = useRef(selectedUdid);
  selectedUdidRef.current = selectedUdid;

  useEffect(() => {
    if (!enabled || !catalogEndpoint) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(withGridQuery(catalogEndpoint, {
          limit,
          offset: 0,
          device: selectedUdidRef.current,
        }));
        const json = await res.json() as GridCatalogResponse;
        if (cancelled) return;
        setCatalog(json.devices ?? []);
        if (typeof json.total === "number") setTotal(json.total);
      } catch {
        if (!cancelled) setCatalog([]);
      }
    };
    void tick();
    const id = setInterval(tick, CATALOG_RECOVERY_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [catalogEndpoint, enabled, refreshKey, limit]);

  useEffect(() => {
    if (!enabled || !statusEventsEndpoint) return;
    const stream = openHostEventStream(withGridQuery(statusEventsEndpoint, {
      device: selectedUdid,
    }));
    stream.onmessage = (event) => {
      try {
        const json = JSON.parse(event.data) as GridStatusResponse;
        if (Array.isArray(json.statuses)) setStatuses(json.statuses);
      } catch {}
    };
    return () => stream.close();
  }, [enabled, selectedUdid, statusEventsEndpoint]);

  const refreshSignature = useRef("");
  useEffect(() => {
    if (!catalog || !gridCatalogNeedsRefresh(catalog, statuses, limit)) {
      refreshSignature.current = "";
      return;
    }
    const signature = statuses.slice(0, limit).map((status) => status.device).join(",");
    if (signature === refreshSignature.current) return;
    refreshSignature.current = signature;
    setRefreshKey((key) => key + 1);
  }, [catalog, statuses, limit]);

  const devices = useMemo(
    () => catalog === null ? null : mergeGridCatalog(catalog, statuses),
    [catalog, statuses],
  );
  const loadMore = useCallback(() => setLimit((l) => l + pageSize), [pageSize]);
  const loadAll = useCallback(() => setLimit(LOAD_ALL_LIMIT), []);
  // Return to the paged window after a one-off search loaded the whole catalog.
  const resetPage = useCallback(() => setLimit(pageSize), [pageSize]);
  const hasMore = total > (devices?.length ?? 0);
  return { devices, total, loadMore, loadAll, resetPage, hasMore };
}
