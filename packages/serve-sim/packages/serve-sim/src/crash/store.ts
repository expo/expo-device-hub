import type { CrashFrame, CrashReport } from "./report";

export const MAX_CRASHES = 20;
export const MAX_OCCURRENCES = 5;

export interface CrashOccurrence {
  key: number;
  incidentId: string | null;
  pid: number | null;
  capturedAt: string | null;
  capturedAtMs: number | null;
  rawPath: string;
  appVersion: string | null;
  buildVersion: string | null;
  faultingQueue: string | null;
  frames: CrashFrame[];
  logTail: string[];
  logTailSource: LogTailSource;
  seenAt: number;
}

export interface CrashRecord extends CrashReport {
  id: string;
  rawPath: string;
  logTailSource: LogTailSource;
  occurrences: CrashOccurrence[];
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export type OccurrenceStamp = {
  key: number;
  capturedAtMs: number | null;
  capturedAt: string | null;
  rawPath: string;
};

export type CrashSummary = Omit<CrashRecord, "frames" | "occurrences"> & {
  logTailLines: number;
  occurrenceCount: number;
  occurrenceTimes: OccurrenceStamp[];
};

export type LogTailSource = "none" | "buffer-rolled-past" | "no-app-lines" | "app-windowed";

export type CrashEvent =
  | { type: "crash" | "recurred"; record: CrashRecord }
  | { type: "evicted"; id: string };

type Listener = (event: CrashEvent) => void;

export class CrashStore {
  private readonly bySignature = new Map<string, CrashRecord>();
  private readonly listeners = new Set<Listener>();
  private readonly closeListeners = new Set<() => void>();
  private seq = 0;
  private occurrenceSeq = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  subscribe(listener: Listener, onClosed?: () => void): () => void {
    this.listeners.add(listener);
    if (onClosed) this.closeListeners.add(onClosed);
    return () => {
      this.listeners.delete(listener);
      if (onClosed) this.closeListeners.delete(onClosed);
    };
  }

  close(): void {
    for (const onClosed of Array.from(this.closeListeners)) {
      try {
        onClosed();
      } catch {}
    }
    this.closeListeners.clear();
    this.listeners.clear();
  }

  record(
    report: CrashReport,
    rawPath: string,
    logTail: string[] = [],
    logTailSource: LogTailSource = "none"
  ): CrashRecord {
    const at = this.now();
    const existing = this.bySignature.get(report.signature);
    const occurrence: CrashOccurrence = {
      key: ++this.occurrenceSeq,
      incidentId: report.incidentId,
      pid: report.pid,
      capturedAt: report.capturedAt,
      capturedAtMs: report.capturedAtMs,
      rawPath,
      appVersion: report.appVersion,
      buildVersion: report.buildVersion,
      faultingQueue: report.faultingQueue,
      frames: copyFrames(report.frames),
      logTail: [...logTail],
      logTailSource,
      seenAt: at,
    };

    const occurrences = [...(existing?.occurrences ?? []), occurrence]
      .sort((a, b) => crashTime(a) - crashTime(b))
      .slice(-MAX_OCCURRENCES);
    const summary =
      !existing || occurrences.at(-1) === occurrence ? { ...report, rawPath, logTailSource } : existing;
    const record: CrashRecord = {
      ...summary,
      frames: copyFrames(summary.frames),
      id: existing?.id ?? report.incidentId ?? `no-incident-${++this.seq}`,
      occurrences,
      count: (existing?.count ?? 0) + 1,
      firstSeen: existing?.firstSeen ?? at,
      lastSeen: at,
    };
    this.bySignature.set(report.signature, record);
    if (!existing) this.evictOverflow();
    this.emit({ type: existing ? "recurred" : "crash", record });
    return snapshot(record);
  }

  list(): CrashRecord[] {
    return [...this.bySignature.values()].sort((a, b) => b.lastSeen - a.lastSeen).map(snapshot);
  }

  get(id: string): CrashRecord | null {
    for (const record of this.bySignature.values()) {
      if (record.id === id) return snapshot(record);
    }
    return null;
  }

  private evictOverflow(): void {
    if (this.bySignature.size <= MAX_CRASHES) return;
    let oldest = [...this.bySignature][0]!;
    for (const entry of this.bySignature) {
      if (entry[1].lastSeen < oldest[1].lastSeen) oldest = entry;
    }
    this.bySignature.delete(oldest[0]);
    this.emit({ type: "evicted", id: oldest[1].id });
  }

  private emit(event: CrashEvent): void {
    const delivered: CrashEvent =
      event.type === "evicted" ? event : { type: event.type, record: snapshot(event.record) };
    for (const listener of this.listeners) {
      try {
        listener(delivered);
      } catch {}
    }
  }
}

function crashTime(occurrence: CrashOccurrence): number {
  return occurrence.capturedAtMs ?? occurrence.seenAt;
}

function copyFrames(frames: CrashFrame[]): CrashFrame[] {
  return frames.map((frame) => ({ ...frame }));
}

function snapshot(record: CrashRecord): CrashRecord {
  return {
    ...record,
    frames: copyFrames(record.frames),
    occurrences: record.occurrences.map((o) => ({
      ...o,
      frames: copyFrames(o.frames),
      logTail: [...o.logTail],
    })),
  };
}
