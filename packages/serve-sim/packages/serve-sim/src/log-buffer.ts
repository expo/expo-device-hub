import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

const LINE_BUFFER_LIMIT = 1024 * 1024;
const RESTART_DELAY_MS = 1000;
const MAX_RESTART_DELAY_MS = 30_000;
const POLL_IDLE_MS = 8_000;

export interface LogLine {
  seq: number;
  at: number;
  raw: string;
}

function emittedBy(raw: string, processName: string): boolean {
  try {
    const path = (JSON.parse(raw) as { processImagePath?: unknown }).processImagePath;
    return typeof path === "string" && path.slice(path.lastIndexOf("/") + 1) === processName;
  } catch {
    return false;
  }
}

function spawnDeviceLogStream(udid: string): ChildProcess {
  return spawn(
    "xcrun",
    ["simctl", "spawn", udid, "log", "stream", "--style", "ndjson", "--level", "info"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
}

export interface LogBufferDeps {
  spawnLogStream?: (udid: string) => ChildProcess;
  maxBytes?: number;
  restartDelayMs?: number;
  idleAfterMs?: number;
  now?: () => number;
}

export class DeviceLogBuffer {
  private child: ChildProcess | null = null;
  private decoder = new StringDecoder("utf8");
  private partial = "";
  private dropping = false;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lines: LogLine[] = [];
  private head = 0;
  private bytes = 0;
  private seq = 0;
  private stopped = false;
  private readonly batchListeners = new Set<(lines: readonly LogLine[]) => void>();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly closeListeners = new Set<() => void>();

  constructor(
    private readonly udid: string,
    private readonly deps: Required<LogBufferDeps>
  ) {}

  get byteLength(): number {
    return this.bytes;
  }

  get status(): "streaming" | "restarting" | "stopped" {
    if (this.child) return "streaming";
    return this.stopped ? "stopped" : "restarting";
  }

  get error(): string | null {
    return this.lastError;
  }

  get listenerCount(): number {
    return this.batchListeners.size;
  }

  subscribeBatch(listener: (lines: readonly LogLine[]) => void, onClosed?: () => void): () => void {
    this.batchListeners.add(listener);
    if (onClosed) this.closeListeners.add(onClosed);
    this.clearIdle();
    return () => {
      this.batchListeners.delete(listener);
      if (onClosed) this.closeListeners.delete(onClosed);
      if (this.listenerCount === 0) this.armIdle();
    };
  }

  start(): void {
    this.stopped = false;
    if (!this.child) this.spawn();
    if (this.listenerCount === 0) this.armIdle();
    else this.clearIdle();
  }

  stop(): void {
    this.stopped = true;
    this.clearIdle();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.child?.removeAllListeners();
    this.child?.stdout?.destroy();
    this.child?.kill();
    this.child = null;
    this.partial = "";
    this.dropping = false;
    for (const onClosed of [...this.closeListeners]) {
      try {
        onClosed();
      } catch {
      }
    }
    this.closeListeners.clear();
  }

  private releaseIfIdle(): void {
    if (this.listenerCount === 0) this.stop();
  }

  read({ since, limit }: { since?: number; limit?: number } = {}): LogLine[] {
    const live = this.head === 0 ? this.lines : this.lines.slice(this.head);
    let selected = since === undefined ? live : live.filter((l) => l.seq > since);
    if (limit !== undefined && selected.length > limit) {
      selected = selected.slice(selected.length - limit);
    }
    return selected === this.lines ? [...selected] : selected;
  }

  tailBefore({
    at,
    count,
    processName,
    maxBytes,
    maxGapMs,
  }: {
    at: number;
    count: number;
    processName: string;
    maxBytes?: number;
    maxGapMs?: number;
  }): { lines: LogLine[]; reason: "app-windowed" | "buffer-rolled-past" | "no-app-lines" } {
    const kept: LogLine[] = [];
    let bytes = 0;
    let sawAppLine = false;
    let newestBefore: LogLine | undefined;
    for (let i = this.lines.length - 1; i >= this.head && kept.length < count; i -= 1) {
      const line = this.lines[i]!;
      if (line.at > at) continue;
      newestBefore ??= line;
      if (!emittedBy(line.raw, processName)) continue;
      sawAppLine = true;
      const size = Buffer.byteLength(line.raw);
      if (maxBytes === undefined || bytes + size <= maxBytes) {
        kept.push(line);
        bytes += size;
        continue;
      }
      if (kept.length > 0) break;
      const fitted = fitLine(line.raw, maxBytes);
      if (fitted === null) continue;
      kept.push({ ...line, raw: fitted });
      break;
    }
    if (!newestBefore) return { lines: [], reason: "buffer-rolled-past" };
    // The ring can hold lines from after the gap, so measure it from the newest line before `at`.
    if (maxGapMs !== undefined && newestBefore.at < at - maxGapMs) {
      return { lines: [], reason: "buffer-rolled-past" };
    }
    if (!sawAppLine) return { lines: [], reason: "no-app-lines" };
    return { lines: kept.reverse(), reason: "app-windowed" };
  }

  get latestSeq(): number {
    return this.seq;
  }

  get oldestSeq(): number {
    return this.lines[this.head]?.seq ?? this.seq;
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.deps.idleAfterMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.releaseIfIdle();
    }, this.deps.idleAfterMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private spawn(): void {
    let child: ChildProcess;
    try {
      child = this.deps.spawnLogStream(this.udid);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.child = null;
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.decoder = new StringDecoder("utf8");
    this.partial = "";
    this.dropping = false;
    const gone = (reason: string): void => {
      if (this.child !== child) return;
      this.lastError = reason;
      this.onChildGone();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.consume(this.decoder.write(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.lastError = chunk.toString().trim().slice(0, 500) || this.lastError;
    });
    child.on("error", (error: Error) => gone(error.message));
    child.on("exit", (code, signal) => gone(`log stream exited (code ${code}, signal ${signal})`));
  }

  private onChildGone(): void {
    this.child = null;
    this.consecutiveFailures += 1;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = Math.min(
      MAX_RESTART_DELAY_MS,
      this.deps.restartDelayMs * 2 ** Math.max(0, this.consecutiveFailures - 1)
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && !this.child) this.spawn();
    }, delay);
    this.restartTimer.unref?.();
  }

  private consume(text: string): void {
    this.partial += text;
    const batch: LogLine[] = [];
    let nl: number;
    while ((nl = this.partial.indexOf("\n")) !== -1) {
      const raw = this.partial.slice(0, nl).trim();
      this.partial = this.partial.slice(nl + 1);
      if (this.dropping) {
        this.dropping = false;
        continue;
      }
      if (raw) batch.push(this.append(raw));
    }
    if (this.partial.length > LINE_BUFFER_LIMIT) {
      this.partial = "";
      this.dropping = true;
    }
    if (batch.length === 0) return;
    for (const listener of this.batchListeners) {
      try {
        listener(batch);
      } catch {
      }
    }
  }

  private append(raw: string): LogLine {
    const line: LogLine = { seq: ++this.seq, at: this.deps.now(), raw };
    this.lines.push(line);
    this.bytes += Buffer.byteLength(raw);
    this.evictOverflow();
    return line;
  }

  private evictOverflow(): void {
    while (this.bytes > this.deps.maxBytes && this.lines.length - this.head > 1) {
      this.bytes -= Buffer.byteLength(this.lines[this.head]!.raw);
      this.head += 1;
    }
    if (this.head > 0 && (this.head > 2048 || this.head * 2 >= this.lines.length)) {
      this.lines = this.lines.slice(this.head);
      this.head = 0;
    }
  }
}

function fitLine(raw: string, maxBytes: number): string | null {
  let entry: { eventMessage?: unknown };
  try {
    entry = JSON.parse(raw) as { eventMessage?: unknown };
  } catch {
    return null;
  }
  if (typeof entry.eventMessage !== "string") return null;
  const chars = Array.from(entry.eventMessage);
  const lineWith = (count: number): string =>
    JSON.stringify({ ...entry, eventMessage: chars.slice(0, count).join("") });
  if (Buffer.byteLength(lineWith(0)) > maxBytes) return null;
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(lineWith(mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return lineWith(low);
}

export type LogBufferCache = ReturnType<typeof createLogBufferCache>;

export function createLogBufferCache(deps: LogBufferDeps = {}) {
  const resolved: Required<LogBufferDeps> = {
    spawnLogStream: deps.spawnLogStream ?? spawnDeviceLogStream,
    maxBytes: deps.maxBytes ?? DEFAULT_MAX_BYTES,
    restartDelayMs: deps.restartDelayMs ?? RESTART_DELAY_MS,
    idleAfterMs: deps.idleAfterMs ?? POLL_IDLE_MS,
    now: deps.now ?? (() => Date.now()),
  };
  const byUdid = new Map<string, DeviceLogBuffer>();

  return {
    ensure(udid: string): DeviceLogBuffer {
      const existing = byUdid.get(udid);
      if (existing) {
        existing.start();
        return existing;
      }
      const buffer = new DeviceLogBuffer(udid, resolved);
      byUdid.set(udid, buffer);
      buffer.start();
      return buffer;
    },

    peek(udid: string): DeviceLogBuffer | null {
      return byUdid.get(udid) ?? null;
    },

    prune(liveUdids: readonly string[]): void {
      pruneByUdid(byUdid, liveUdids, (buffer) => buffer.stop());
    },

    stopAll(): void {
      for (const buffer of byUdid.values()) buffer.stop();
      byUdid.clear();
    },
  };
}

export function pruneByUdid<T>(
  byUdid: Map<string, T>,
  liveUdids: readonly string[],
  dispose: (entry: T) => void
): void {
  if (liveUdids.length === 0) return;
  const live = new Set(liveUdids);
  for (const [udid, entry] of byUdid) {
    if (live.has(udid) || byUdid.get(udid) !== entry) continue;
    dispose(entry);
    byUdid.delete(udid);
  }
}

export const logBufferCache = createLogBufferCache();
