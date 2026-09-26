import { join } from "node:path";

import { claimCaptureDirectory, releaseCaptureDirectory } from "./artifact-owner";
import { appendFileNoFollow, appendFileNoFollowSync, writeFileNoFollow } from "./no-follow";
import { MAX_HAR_ENTRIES, toHarEntry, type HarEntry } from "./har";
import { compactNdjsonAndStreamHar, emptyHarText } from "./har-stream";
import type { CapturedBody, CapturedRequest, CaptureEvent, CaptureStore } from "./store";
import { stateDir } from "../state";

export { CAPTURE_OWNER_FILENAME, sweepAbandonedCaptureDirs } from "./artifact-owner";

export const NETWORK_CAPTURE_FILENAME = "network-capture.json";
export const CAPTURE_HAR_FILENAME = "capture.har";
export const CAPTURE_ENTRIES_FILENAME = "capture.entries.ndjson";

export function captureDirForDevice(udid: string): string {
  return join(stateDir(), `capture-${udid}`);
}

export function captureArtifactPaths(udid: string): {
  dir: string;
  networkCapturePath: string;
  harPath: string;
  entriesPath: string;
} {
  const dir = captureDirForDevice(udid);
  return {
    dir,
    networkCapturePath: join(dir, NETWORK_CAPTURE_FILENAME),
    harPath: join(dir, CAPTURE_HAR_FILENAME),
    entriesPath: join(dir, CAPTURE_ENTRIES_FILENAME),
  };
}

export interface CaptureDiskAccumulatorOptions {
  dir: string;
  networkCapturePath?: string;
  harPath?: string;
  entriesPath?: string;
  ownerFile?: string;
  creatorVersion?: string;
  flushIntervalMs?: number;
  maxEntries?: number;
  /** Rebuilds the HAR from the entry log; replaceable in tests. */
  compact?: typeof compactNdjsonAndStreamHar;
}

export class CaptureDiskAccumulator {
  readonly dir: string;
  readonly networkCapturePath: string;
  readonly harPath: string;
  readonly entriesPath: string;
  private readonly ownerFile: string | undefined;
  private readonly creatorVersion: string;
  private readonly maxEntries: number;
  private readonly flushMs: number;
  private readonly compact: typeof compactNdjsonAndStreamHar;
  private diskEntryCount = 0;
  private harDirty = false;
  private lastWriteError: unknown = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private pendingEventLines: string[] = [];
  private pendingEntryLines: string[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private started = false;
  private owner: string | null = null;
  private ending: Promise<Error | null> | null = null;

  constructor(opts: CaptureDiskAccumulatorOptions) {
    this.dir = opts.dir;
    this.networkCapturePath =
      opts.networkCapturePath ?? join(opts.dir, NETWORK_CAPTURE_FILENAME);
    this.harPath = opts.harPath ?? join(opts.dir, CAPTURE_HAR_FILENAME);
    this.entriesPath = opts.entriesPath ?? join(opts.dir, CAPTURE_ENTRIES_FILENAME);
    this.ownerFile = opts.ownerFile;
    this.creatorVersion = opts.creatorVersion ?? "0.0.0";
    this.maxEntries = opts.maxEntries ?? MAX_HAR_ENTRIES;
    this.flushMs = opts.flushIntervalMs ?? 5_000;
    this.compact = opts.compact ?? compactNdjsonAndStreamHar;
  }

  get size(): number {
    return this.diskEntryCount + this.pendingEntryLines.length;
  }

  begin(): void {
    if (this.started) return;
    const owner = claimCaptureDirectory(this.dir, this.ownerFile);
    try {
      writeFileNoFollow(this.networkCapturePath, "");
      writeFileNoFollow(this.entriesPath, "");
      writeFileNoFollow(this.harPath, emptyHarText(this.creatorVersion));
      this.owner = owner;
    } catch (error) {
      releaseCaptureDirectory(this.dir, owner, false, this.ownerFile);
      throw error;
    }
    this.ending = null;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pendingEventLines = [];
    this.pendingEntryLines = [];
    this.writeChain = Promise.resolve();
    this.diskEntryCount = 0;
    this.harDirty = false;
    this.lastWriteError = null;

    this.timer = setInterval(() => {
      void this.rebuildHarIfDirty();
    }, this.flushMs);
    this.timer.unref?.();
    this.started = true;
  }

  attach(store: CaptureStore): () => Promise<void> {
    this.begin();
    this.unsubscribe = store.subscribe((event) => this.onStoreEvent(store, event));
    this.recordEvent({ type: "session", startedAt: new Date().toISOString() });
    return async () => {
      await this.end({ removeDir: true });
    };
  }

  recordEvent(event: unknown): void {
    if (!this.started) this.begin();
    this.pendingEventLines.push(typeof event === "string" ? event : JSON.stringify(event));
    this.enqueue(() => this.flushPendingEvents());
  }

  recordFinished(request: CapturedRequest, body: CapturedBody | null = null): void {
    this.recordHarEntry(toHarEntry(request, body));
  }

  /** Append an entry already in HAR form, such as one copied from another recording. */
  recordHarEntry(entry: HarEntry): void {
    if (!this.started) this.begin();
    this.pendingEntryLines.push(JSON.stringify(entry));
    this.harDirty = true;
    this.enqueue(() => this.flushPendingEntries());
  }

  /** Write every recorded entry to the entry log, without rebuilding the HAR. */
  async flushEntries(): Promise<void> {
    await this.drainPending();
  }

  /** Resolves once queued writes finish, so a fast producer can wait instead of buffering. */
  async settled(): Promise<void> {
    await this.writeChain;
  }

  async flush(): Promise<void> {
    await this.drainPending();
    await this.rebuildHarIfDirty();
    await this.writeChain;
    if (this.lastWriteError) {
      const err = this.lastWriteError;
      this.lastWriteError = null;
      throw err;
    }
  }

  end(opts: { removeDir?: boolean } = {}): Promise<Error | null> {
    if (!this.ending) this.ending = this.finish(opts);
    return this.ending;
  }

  private async finish(opts: { removeDir?: boolean }): Promise<Error | null> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    let failure: Error | null = null;
    try {
      await this.flush();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      console.warn(`Network capture: flush before end (${this.dir}) failed, so its files were kept:`, failure.message);
    }
    try {
      const removeDir = failure === null && (opts.removeDir ?? false);
      if (this.owner) releaseCaptureDirectory(this.dir, this.owner, removeDir, this.ownerFile);
    } catch (error) {
      console.warn(`Network capture: releasing ${this.dir} failed:`, error);
    }
    this.owner = null;
    return failure;
  }

  async stop(): Promise<void> {
    await this.end({ removeDir: true });
  }

  /** Remove the recording without a final flush. For `process.on("exit")`, which cannot await. */
  discardSync(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    // Nothing is left to flush, so a later end() must not write into the removed directory.
    this.ending = Promise.resolve(null);
    const owner = this.owner;
    this.owner = null;
    if (owner) releaseCaptureDirectory(this.dir, owner, true, this.ownerFile);
  }

  private enqueue(task: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(task).catch((err) => {
      this.harDirty = true;
      this.lastWriteError = err;
    });
  }

  private onStoreEvent(store: CaptureStore, event: CaptureEvent): void {
    this.recordEvent(event);

    if (event.type === "cleared") return;
    if (event.type === "meta") return;
    if (event.type !== "finished") return;

    this.recordFinished(event.request, store.body(event.request.id));
  }

  private async flushPendingEvents(): Promise<void> {
    if (this.pendingEventLines.length === 0) return;
    const batch = this.pendingEventLines.splice(0, this.pendingEventLines.length);
    try {
      await appendFileNoFollow(this.networkCapturePath, `${batch.join("\n")}\n`);
    } catch (err) {
      this.pendingEventLines.unshift(...batch);
      throw err;
    }
  }

  private async flushPendingEntries(): Promise<void> {
    if (this.pendingEntryLines.length === 0) return;
    const batch = this.pendingEntryLines.splice(0, this.pendingEntryLines.length);
    try {
      await appendFileNoFollow(this.entriesPath, `${batch.join("\n")}\n`);
      this.diskEntryCount += batch.length;
    } catch (err) {
      this.pendingEntryLines.unshift(...batch);
      throw err;
    }
  }

  private async drainPending(): Promise<void> {
    await this.writeChain;
    if (this.pendingEventLines.length > 0) {
      const batch = this.pendingEventLines.splice(0, this.pendingEventLines.length);
      try {
        appendFileNoFollowSync(this.networkCapturePath, `${batch.join("\n")}\n`);
      } catch (err) {
        this.pendingEventLines.unshift(...batch);
        throw err;
      }
    }
    if (this.pendingEntryLines.length > 0) {
      const batch = this.pendingEntryLines.splice(0, this.pendingEntryLines.length);
      try {
        appendFileNoFollowSync(this.entriesPath, `${batch.join("\n")}\n`);
        this.diskEntryCount += batch.length;
        this.harDirty = true;
      } catch (err) {
        this.pendingEntryLines.unshift(...batch);
        throw err;
      }
    }
  }

  private async rebuildHarIfDirty(): Promise<void> {
    if (!this.harDirty) return;
    this.enqueue(async () => {
      // Several flushes can queue while one rebuild runs; later ones find nothing new and skip.
      if (!this.harDirty) return;
      this.harDirty = false;
      await this.flushPendingEntries();
      this.diskEntryCount = await this.compact(
        this.entriesPath,
        this.harPath,
        this.creatorVersion,
        this.maxEntries,
      );
      this.lastWriteError = null;
    });
    await this.writeChain;
  }
}
