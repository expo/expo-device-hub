import { parseDeviceLogJson, type DeviceLogFields } from "./device-log-format";
import { startExclusivePoll } from "./exclusive-poll";
import { simAuthHeaders } from "./sim-endpoint";

const LOGS_POLL_MS = 2000;
const LOGS_POLL_LIMIT = 800;
const LOGS_REPLAY_LIMIT = 400;

export type LogSnapshotLine = { seq: number; fields: DeviceLogFields };

export function logsSnapshotUrl(endpoint: string, since: number): string {
  const url = new URL(endpoint, "http://127.0.0.1");
  url.searchParams.set("snapshot", "1");
  url.searchParams.set("follow", "1");
  url.searchParams.set("limit", String(since > 0 ? LOGS_POLL_LIMIT : LOGS_REPLAY_LIMIT));
  if (since > 0) url.searchParams.set("since", String(since));
  else url.searchParams.delete("since");
  return `${url.pathname}${url.search}`;
}

export function parseLogSnapshot(payload: unknown): {
  latestSeq: number;
  firstSeq: number | null;
  lines: LogSnapshotLine[];
} | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as { latestSeq?: unknown; lines?: unknown };
  const latestSeq = record.latestSeq;
  const rows = record.lines;
  if (typeof latestSeq !== "number" || !Number.isSafeInteger(latestSeq) || !Array.isArray(rows)) {
    return null;
  }
  const lines: LogSnapshotLine[] = [];
  let firstSeq: number | null = null;
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const item = row as { seq?: unknown; raw?: unknown };
    if (typeof item.seq === "number" && Number.isSafeInteger(item.seq)) {
      firstSeq = firstSeq === null ? item.seq : Math.min(firstSeq, item.seq);
    }
    if (typeof item.seq !== "number" || typeof item.raw !== "string") continue;
    const fields = parseDeviceLogJson(item.raw);
    if (!fields) continue;
    lines.push({ seq: item.seq, fields });
  }
  return { latestSeq, firstSeq, lines };
}

function skippedLine(seq: number, count: number): LogSnapshotLine {
  return {
    seq,
    fields: {
      process: "serve-sim",
      library: "",
      subsystem: "",
      category: "",
      message: `${count} ${count === 1 ? "line" : "lines"} skipped`,
      level: "default",
      pid: null,
      timestamp: "",
    },
  };
}

export function startLogsPoll(
  endpoint: string,
  opts: {
    getSince: () => number;
    setSince: (seq: number) => void;
    onBatch: (lines: LogSnapshotLine[]) => void;
    onError?: (errored: boolean) => void;
  }
): () => void {
  let stopped = false;
  let activeRequest: AbortController | null = null;

  const sample = async (): Promise<void> => {
    const since = opts.getSince();
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), LOGS_POLL_MS * 3);
    try {
      const response = await fetch(logsSnapshotUrl(endpoint, since), {
        headers: { Accept: "application/json", ...simAuthHeaders() },
        signal: controller.signal,
      });
      if (stopped) return;
      if (!response.ok) {
        opts.onError?.(/* errored */ true);
        return;
      }
      const parsed = parseLogSnapshot(await response.json());
      if (stopped) return;
      if (!parsed) {
        opts.onError?.(/* errored */ true);
        return;
      }
      opts.onError?.(/* errored */ false);
      if (parsed.latestSeq < since) {
        opts.setSince(0);
        return;
      }
      const fresh = parsed.lines.filter((line) => line.seq > since);
      if (parsed.latestSeq > since) opts.setSince(parsed.latestSeq);
      const first = parsed.firstSeq;
      const skipped = since > 0 && first !== null && first > since ? first - since - 1 : 0;
      const batch = skipped > 0 ? [skippedLine(since + 1, skipped), ...fresh] : fresh;
      if (batch.length > 0) opts.onBatch(batch);
    } catch {
      if (!stopped) opts.onError?.(/* errored */ true);
    } finally {
      clearTimeout(timeout);
      activeRequest = null;
    }
  };

  const stopPolling = startExclusivePoll(sample, LOGS_POLL_MS);
  return () => {
    stopped = true;
    activeRequest?.abort();
    stopPolling();
  };
}
