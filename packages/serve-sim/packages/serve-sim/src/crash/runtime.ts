// Simulator apps are host processes, so the host's ReportCrash writes their `.ips`.

import { mkdirSync, watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isSimulatorAppCrash, parseCrashReport, parseIpsHeader, type CrashReport } from "./report";
import { logBufferCache, POLL_IDLE_MS, pruneByUdid, type LogBufferCache } from "../log-buffer";
import { CrashStore, type CrashEvent, type CrashRecord, type LogTailSource } from "./store";

const DEFAULT_REPORTS_DIR = join(homedir(), "Library", "Logs", "DiagnosticReports");

const CRASH_SCHEMA_VERSION = 1;
const REPORT_DELAY_SECONDS = 5;
const RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_WATCH_RETRIES = 6;
const HEALTHY_WATCH_MS = 60_000;
const MAX_TAIL_GAP_MS = POLL_IDLE_MS + 2_000;
const LOG_TAIL_LINES = 60;
const LOG_TAIL_MAX_BYTES = 64 * 1024;

type CrashWatchStatus = "idle" | "watching" | "unavailable";

export interface CrashMeta {
  schemaVersion: number;
  status: CrashWatchStatus;
  statusError: string | null;
  reportsDir: string;
  reportDelaySeconds: number;
}

interface CrashWatcherHandle {
  close: () => void;
}

export interface CrashRuntimeOptions {
  reportsDir?: string;
  ensureDir?: (dir: string) => void;
  watchDir?: (
    dir: string,
    listener: (eventType: string, filename: string | null) => void,
    onWatchError: (error: unknown) => void
  ) => CrashWatcherHandle;
  readReport?: (path: string) => Promise<string>;
  readDir?: (dir: string) => Promise<string[]>;
  statFile?: (path: string) => Promise<{ mtimeMs: number; ino: number }>;
  now?: () => number;
  onError?: (message: string, error: unknown) => void;
  retryDelayMs?: number;
  logBuffers?: Pick<LogBufferCache, "peek">;
}

export type CrashRuntime = ReturnType<typeof createCrashRuntime>;

function isFinalCrashReportName(filename: string): boolean {
  // Skip ReportCrash's in-progress `.`-prefixed temp file.
  return filename.endsWith(".ips") && !filename.startsWith(".");
}

export function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function createCrashRuntime(options: CrashRuntimeOptions = {}) {
  const reportsDir = options.reportsDir ?? DEFAULT_REPORTS_DIR;
  const ensureDir =
    options.ensureDir ?? ((dir: string) => void mkdirSync(dir, { recursive: true }));
  const watchDir =
    options.watchDir ??
    ((dir, listener, onWatchError) => {
      const watcher = watch(dir, (eventType, filename) => listener(eventType, filename));
      watcher.on("error", onWatchError);
      return watcher;
    });
  const readReport = options.readReport ?? ((path: string) => readFile(path, "utf8"));
  const readDir = options.readDir ?? ((dir: string) => readdir(dir));
  const statFile =
    options.statFile ??
    (async (path: string) => {
      const { mtimeMs, ino } = await stat(path);
      return { mtimeMs, ino };
    });
  const clock = options.now ?? (() => Date.now());
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const logBuffers = options.logBuffers ?? logBufferCache;
  const reportError =
    options.onError ??
    ((message: string, error: unknown) => {
      console.warn(`Crash watcher: ${message}:`, error instanceof Error ? error.message : error);
    });

  const byUdid = new Map<string, CrashStore>();
  const ingested = new Map<string, { ino: number; udid: string | null }>();
  let watcher: CrashWatcherHandle | null = null;
  let running = false;
  let statusError: string | null = null;
  let startedAt: number | null = null;
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let gaveUp = false;
  let watcherSince: number | null = null;
  let backfilling: Promise<void> | null = null;

  const markUnavailable = (error: unknown): void => {
    if (watcherSince !== null && clock() - watcherSince >= HEALTHY_WATCH_MS) retries = 0;
    watcherSince = null;
    const reason = error instanceof Error ? error.message : String(error);
    generation += 1;
    if (!retryTimer && retries >= MAX_WATCH_RETRIES) gaveUp = true;
    statusError =
      `Crash reports are not being collected: serve-sim could not watch ${reportsDir} (${reason}). ` +
      "Check that the directory is readable and writable and that macOS crash reporting is enabled " +
      "on this host." +
      (gaveUp ? " Retries are exhausted; restart serve-sim to try again." : "");
    running = false;
    watcher?.close();
    watcher = null;
    if (!gaveUp) reportError(`could not watch ${reportsDir}`, error);
    if (retryTimer || gaveUp) return;
    const delay = Math.min(retryDelayMs * 2 ** retries, MAX_RETRY_DELAY_MS);
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!running) void start().catch(() => {});
    }, delay);
    retryTimer.unref?.();
  };

  const storeFor = (udid: string): CrashStore => {
    const existing = byUdid.get(udid);
    if (existing) return existing;
    const store = new CrashStore(clock);
    byUdid.set(udid, store);
    return store;
  };

  const logTailFor = (
    report: Pick<CrashReport, "deviceUdid" | "capturedAtMs" | "procName" | "pid">
  ): { logTail: string[]; logTailSource: LogTailSource } => {
    const none = { logTail: [], logTailSource: "none" as const };
    if (!report.deviceUdid || report.capturedAtMs === null || !report.procName) return none;
    const buffer = logBuffers.peek(report.deviceUdid);
    if (!buffer) return none;
    const tail = buffer.tailBefore({
      at: report.capturedAtMs,
      count: LOG_TAIL_LINES,
      processName: report.procName,
      processId: report.pid,
      maxBytes: LOG_TAIL_MAX_BYTES,
      maxGapMs: MAX_TAIL_GAP_MS,
    });
    return { logTail: tail.lines.map((line) => line.raw), logTailSource: tail.reason };
  };

  const ingest = async (
    filename: string,
    claim: { ino: number; udid: string | null }
  ): Promise<void> => {
    const epoch = generation;
    const releaseClaim = (): void => {
      if (ingested.get(filename) === claim) ingested.delete(filename);
    };
    const path = join(reportsDir, filename);
    let raw: string;
    try {
      raw = await readReport(path);
    } catch (error) {
      if (!isMissingFile(error)) reportError(`could not read ${filename}`, error);
      releaseClaim();
      return;
    }

    if (!running || epoch !== generation) {
      releaseClaim();
      return;
    }

    if (!isSimulatorAppCrash(parseIpsHeader(raw))) return;

    const report = parseCrashReport(raw);
    if (!report?.deviceUdid) {
      reportError(
        `could not read the crash out of ${filename}`,
        new Error(
          report
            ? "The report has no simulator device in its process path, so there is nothing to attach it to."
            : "The report looked like a simulator app crash but its body did not parse."
        )
      );
      return;
    }
    claim.udid = report.deviceUdid;

    const tail = logTailFor(report);
    storeFor(report.deviceUdid).record(report, path, tail.logTail, tail.logTailSource);
  };

  const consider = async (filename: string, cutoff?: number): Promise<void> => {
    if (!running || !isFinalCrashReportName(filename)) return;
    const epoch = generation;
    const previous = ingested.get(filename);
    let file: { mtimeMs: number; ino: number };
    try {
      file = await statFile(join(reportsDir, filename));
    } catch (error) {
      if (!isMissingFile(error)) reportError(`could not stat ${filename}`, error);
      else if (ingested.get(filename) === previous) ingested.delete(filename);
      return;
    }
    if (!running || epoch !== generation) return;
    if (cutoff !== undefined && file.mtimeMs < cutoff) return;
    if (ingested.get(filename)?.ino === file.ino) return;
    const claim = { ino: file.ino, udid: null };
    ingested.set(filename, claim);
    await ingest(filename, claim);
  };

  const backfillAsync = async (): Promise<void> => {
    const cutoff = startedAt;
    if (cutoff === null) return;
    const epoch = generation;
    const claimedBefore = [...ingested.entries()];

    let filenames: string[];
    try {
      filenames = await readDir(reportsDir);
    } catch (error) {
      if (!isMissingFile(error)) reportError(`could not list ${reportsDir}`, error);
      return;
    }

    if (epoch !== generation || !running) return;
    const listed = new Set(filenames);
    for (const [filename, claim] of claimedBefore) {
      if (!listed.has(filename) && ingested.get(filename) === claim) ingested.delete(filename);
    }

    const candidates: { filename: string; mtimeMs: number }[] = [];
    for (const filename of filenames) {
      if (epoch !== generation || !running) return;
      if (!isFinalCrashReportName(filename)) continue;
      try {
        const { mtimeMs } = await statFile(join(reportsDir, filename));
        if (mtimeMs >= cutoff) candidates.push({ filename, mtimeMs });
      } catch (error) {
        if (!isMissingFile(error)) reportError(`could not stat ${filename}`, error);
      }
    }

    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { filename } of candidates) {
      if (epoch !== generation || !running) return;
      await consider(filename, cutoff);
    }
  };

  async function start(opts: { deferToRetry?: boolean } = {}): Promise<void> {
    if (watcher) {
      await backfilling;
      return;
    }
    if (gaveUp) return;
    if (opts.deferToRetry && retryTimer) return;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    try {
      ensureDir(reportsDir);
      running = true;
      statusError = null;
      startedAt ??= clock();
      const handle = watchDir(
        reportsDir,
        (_eventType, filename) => {
          if (!filename) return;
          void consider(filename).catch((error) =>
            reportError(`could not ingest ${filename}`, error)
          );
        },
        markUnavailable
      );
      if (running) {
        watcher = handle;
        watcherSince = clock();
      } else handle.close();
    } catch (error) {
      markUnavailable(error);
      return;
    }
    const run = backfillAsync();
    backfilling = run;
    try {
      await run;
    } finally {
      if (backfilling === run) backfilling = null;
    }
  }

  return {
    arm(): void {
      startedAt ??= clock();
    },

    start,

    stop(): void {
      generation += 1;
      running = false;
      retries = 0;
      gaveUp = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      watcher?.close();
      watcher = null;
      watcherSince = null;
      for (const store of byUdid.values()) store.close();
      byUdid.clear();
      ingested.clear();
    },

    prune(liveUdids: readonly string[]): void {
      const before = [...byUdid.keys()];
      pruneByUdid(byUdid, liveUdids, (store) => store.close());
      const pruned = new Set(before.filter((udid) => !byUdid.has(udid)));
      if (pruned.size === 0) return;
      for (const [filename, entry] of ingested) {
        if (entry.udid !== null && pruned.has(entry.udid)) ingested.delete(filename);
      }
    },

    meta(): CrashMeta {
      return {
        schemaVersion: CRASH_SCHEMA_VERSION,
        status: running ? "watching" : statusError ? "unavailable" : "idle",
        statusError,
        reportsDir,
        reportDelaySeconds: REPORT_DELAY_SECONDS,
      };
    },

    listFor(udid: string): CrashRecord[] {
      return byUdid.get(udid)?.list() ?? [];
    },

    getFor(udid: string, id: string): CrashRecord | null {
      return byUdid.get(udid)?.get(id) ?? null;
    },

    subscribe(
      udid: string,
      listener: (event: CrashEvent) => void,
      onClosed?: () => void
    ): { crashes: CrashRecord[]; unsubscribe: () => void } {
      const store = storeFor(udid);
      return { crashes: store.list(), unsubscribe: store.subscribe(listener, onClosed) };
    },
  };
}

export const crashRuntime = createCrashRuntime();
