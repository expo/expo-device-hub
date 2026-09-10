import { execText } from "./exec.ts";
import {
  FOREGROUND_ACTIVITY_GREP,
  FOREGROUND_WINDOW_GREP,
  parseForegroundActivityDump,
  parseForegroundWindowDump,
} from "./foreground-component.ts";
import type { MetricSample, MetricsMeta } from "./shared/api-contracts.ts";

export const DEFAULT_MAX_METRICS_SUBSCRIBERS = 8;

const METRICS_SAMPLE_INTERVAL_MS = 1_000;
const METRICS_PROBE_TIMEOUT_MS = 4_000;
const METRICS_HEARTBEAT_MS = 15_000;

// Network is device-wide: this emulator exposes no per-uid counters
// (`xt_qtaguid` and `uid_stat` are absent, `/sys/fs/bpf` is denied).
//
// The device does not choose the foreground app. It echoes the dump lines the
// shared detector reads plus the stats of every package those lines name, and
// `parseMetricsProbe` chooses among them exactly as `/api/foreground` does.
// Collecting stats for every candidate keeps the tick at one `adb shell`, since
// `pidof` needs a package name before the host has parsed one.
const METRICS_PROBE_SCRIPT = [
  "echo ---stat; head -n1 /proc/stat; grep -c '^cpu[0-9]' /proc/stat",
  `echo ---fgwin; W=$(dumpsys window 2>/dev/null | grep -E '${FOREGROUND_WINDOW_GREP}'); echo "$W"`,
  `echo ---fgact; A=$(dumpsys activity activities 2>/dev/null | grep -E '${FOREGROUND_ACTIVITY_GREP}'); echo "$A"`,
  "echo ---proc",
  "for PKG in $(printf '%s\\n%s\\n' \"$W\" \"$A\" | grep -oE '[A-Za-z0-9_][A-Za-z0-9_.]*/[A-Za-z0-9_.$]+' | sed 's|/.*||' | sort -u); do",
  '  P=$(pidof "$PKG" 2>/dev/null); P=${P%% *}',
  '  [ -n "$P" ] || continue',
  '  echo "pkg $PKG"; echo "pid $P"',
  '  echo "stat $(cat /proc/$P/stat 2>/dev/null)"',
  '  echo "rss $(grep VmRSS /proc/$P/status 2>/dev/null)"',
  "done",
  "echo ---net; cat /proc/net/dev",
].join("\n");

export type MetricsProbe = {
  cores: number;
  totalJiffies: number;
  packageName: string | null;
  pid: number | null;
  procJiffies: number | null;
  rssBytes: number | null;
  netRxBytes: number;
  netTxBytes: number;
};

function sections(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const marker = /^---(\w+)$/.exec(raw.trim());
    if (marker) {
      current = [];
      out.set(marker[1]!, current);
      continue;
    }
    current?.push(raw);
  }
  return out;
}

function integer(value: string | undefined): number | null {
  const text = value?.trim();
  return text && /^-?\d+$/.test(text) ? Number(text) : null;
}

function parseProcJiffies(statLine: string | undefined): number | null {
  const closing = statLine?.lastIndexOf(")") ?? -1;
  if (statLine === undefined || closing < 0) return null;
  const fields = statLine
    .slice(closing + 1)
    .trim()
    .split(/\s+/);
  const utime = integer(fields[11]);
  const stime = integer(fields[12]);
  return utime === null || stime === null ? null : utime + stime;
}

function parseVmRss(statusLine: string | undefined): number | null {
  const kb = integer(/VmRSS:\s*(\d+)\s*kB/.exec(statusLine ?? "")?.[1]);
  return kb === null ? null : kb * 1024;
}

function parseNetDev(lines: string[]): { netRxBytes: number; netTxBytes: number } {
  let netRxBytes = 0;
  let netTxBytes = 0;
  for (const line of lines) {
    const match = /^\s*([^\s:]+):\s*(.*)$/.exec(line);
    if (!match || match[1] === "lo") continue;
    const fields = match[2]!.trim().split(/\s+/);
    netRxBytes += integer(fields[0]) ?? 0;
    netTxBytes += integer(fields[8]) ?? 0;
  }
  return { netRxBytes, netTxBytes };
}

type ProcStats = { pid: number | null; procJiffies: number | null; rssBytes: number | null };

function procStatsFor(lines: string[], packageName: string | null): ProcStats {
  const stats: ProcStats = { pid: null, procJiffies: null, rssBytes: null };
  if (packageName === null) return stats;
  let inTarget = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const split = trimmed.indexOf(" ");
    if (split < 0) continue;
    const key = trimmed.slice(0, split);
    const value = trimmed.slice(split + 1);
    if (key === "pkg") inTarget = value === packageName;
    else if (!inTarget) continue;
    else if (key === "pid") stats.pid = integer(value);
    else if (key === "stat") stats.procJiffies = parseProcJiffies(value);
    else if (key === "rss") stats.rssBytes = parseVmRss(value);
  }
  return stats;
}

export function parseMetricsProbe(stdout: string): MetricsProbe | null {
  const parts = sections(stdout);
  const stat = parts.get("stat") ?? [];
  const cpuFields = stat[0]?.trim().split(/\s+/) ?? [];
  if (cpuFields[0] !== "cpu") return null;
  // user..steal only. The trailing guest and guest_nice fields are already
  // counted inside user and nice, so summing all ten inflates the divisor.
  const totalJiffies = cpuFields
    .slice(1, 9)
    .reduce((sum, field) => sum + (integer(field) ?? Number.NaN), 0);
  const cores = integer(stat[1]);
  if (!Number.isFinite(totalJiffies) || cores === null || cores < 1) return null;
  const component =
    parseForegroundWindowDump((parts.get("fgwin") ?? []).join("\n")) ??
    parseForegroundActivityDump((parts.get("fgact") ?? []).join("\n"));
  const packageName = component?.packageName ?? null;
  return {
    cores,
    totalJiffies,
    packageName,
    ...procStatsFor(parts.get("proc") ?? [], packageName),
    ...parseNetDev(parts.get("net") ?? []),
  };
}

export type MetricsReading = { t: number; probe: MetricsProbe };

export function deriveMetricSample(
  prev: MetricsReading | null,
  probe: MetricsProbe,
  t: number,
): MetricSample {
  let cpuPct = 0;
  let netInBytesPerSec = 0;
  let netOutBytesPerSec = 0;
  if (prev && t > prev.t) {
    const seconds = (t - prev.t) / 1000;
    netInBytesPerSec = Math.max(0, probe.netRxBytes - prev.probe.netRxBytes) / seconds;
    netOutBytesPerSec = Math.max(0, probe.netTxBytes - prev.probe.netTxBytes) / seconds;
    const deltaTotal = probe.totalJiffies - prev.probe.totalJiffies;
    const samePid = probe.pid !== null && probe.pid === prev.probe.pid;
    if (samePid && probe.procJiffies !== null && prev.probe.procJiffies !== null && deltaTotal > 0) {
      const deltaProc = Math.max(0, probe.procJiffies - prev.probe.procJiffies);
      cpuPct = (deltaProc * probe.cores * 100) / deltaTotal;
    }
  }
  return {
    t,
    bundleId: probe.packageName,
    cpuPct: Math.round(cpuPct * 10) / 10,
    memBytes: probe.rssBytes ?? 0,
    netInBytesPerSec: Math.round(netInBytesPerSec),
    netOutBytesPerSec: Math.round(netOutBytesPerSec),
  };
}

type MetricsSamplerOptions = {
  serial: string;
  runExec?: typeof execText;
  intervalMs?: number;
  maxSubscribers?: number;
  now?: () => number;
};

type Subscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  metaSent: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
  abortListener: (() => void) | null;
  signal: AbortSignal | undefined;
};

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export class MetricsSampler {
  readonly serial: string;
  readonly #runExec: typeof execText;
  readonly #intervalMs: number;
  readonly #maxSubscribers: number;
  readonly #now: () => number;
  readonly #subscribers = new Set<Subscriber>();
  readonly #encoder = new TextEncoder();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #ticking = false;
  #startedAt: number | null = null;
  #prev: MetricsReading | null = null;
  #cores: number | null = null;
  #closed = false;

  constructor(options: MetricsSamplerOptions) {
    if (!options.serial) throw new TypeError("serial must not be empty");
    this.serial = options.serial;
    this.#runExec = options.runExec ?? execText;
    this.#intervalMs = options.intervalMs ?? METRICS_SAMPLE_INTERVAL_MS;
    this.#maxSubscribers = options.maxSubscribers ?? DEFAULT_MAX_METRICS_SUBSCRIBERS;
    this.#now = options.now ?? (() => performance.now());
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  get running(): boolean {
    return this.#timer !== null || this.#ticking;
  }

  get meta(): MetricsMeta | null {
    if (this.#cores === null) return null;
    return {
      schemaVersion: 1,
      udid: this.serial,
      hostCores: this.#cores,
      sampleIntervalMs: this.#intervalMs,
    };
  }

  subscribe(signal?: AbortSignal): Response {
    if (this.#closed) {
      return Response.json(
        { ok: false, code: "metrics-session-closed", error: "metrics session is closed" },
        { status: 409 },
      );
    }
    if (signal?.aborted) {
      return Response.json(
        { ok: false, code: "metrics-request-aborted", error: "request was aborted" },
        { status: 499 },
      );
    }
    if (this.#subscribers.size >= this.#maxSubscribers) {
      return Response.json(
        {
          ok: false,
          code: "metrics-subscriber-limit",
          error: `metrics subscriber limit is ${this.#maxSubscribers}`,
        },
        { status: 429 },
      );
    }
    let subscriber: Subscriber | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = {
          controller,
          metaSent: false,
          heartbeat: null,
          abortListener: null,
          signal,
        };
        this.#subscribers.add(subscriber);
        this.#write(subscriber, ":\n\n");
        this.#writeMeta(subscriber);
        subscriber.heartbeat = setInterval(
          () => this.#write(subscriber!, ":\n\n"),
          METRICS_HEARTBEAT_MS,
        );
        if (signal) {
          const onAbort = () => this.#remove(subscriber!);
          subscriber.abortListener = onAbort;
          signal.addEventListener("abort", onAbort, { once: true });
        }
        this.#schedule(0);
      },
      cancel: () => {
        if (subscriber) this.#remove(subscriber);
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of [...this.#subscribers]) this.#remove(subscriber);
  }

  #writeMeta(subscriber: Subscriber): void {
    const meta = this.meta;
    if (subscriber.metaSent || !meta) return;
    subscriber.metaSent = true;
    this.#write(subscriber, `event: meta\ndata: ${JSON.stringify(meta)}\n\n`);
  }

  #write(subscriber: Subscriber, text: string): void {
    try {
      subscriber.controller.enqueue(this.#encoder.encode(text));
    } catch {
      this.#remove(subscriber);
    }
  }

  #remove(subscriber: Subscriber): void {
    if (!this.#subscribers.delete(subscriber)) return;
    if (subscriber.heartbeat) clearInterval(subscriber.heartbeat);
    if (subscriber.abortListener) {
      subscriber.signal?.removeEventListener("abort", subscriber.abortListener);
    }
    try {
      subscriber.controller.close();
    } catch {}
    if (this.#subscribers.size === 0) this.#stop();
  }

  #schedule(delayMs: number): void {
    if (this.#timer || this.#ticking || this.#closed || this.#subscribers.size === 0) return;
    this.#startedAt ??= this.#now();
    this.#timer = setTimeout(() => void this.#tick(), delayMs);
  }

  #stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#prev = null;
  }

  async #tick(): Promise<void> {
    this.#timer = null;
    this.#ticking = true;
    try {
      const t = this.#now() - (this.#startedAt ?? this.#now());
      const probe = await this.#probe();
      if (probe && this.#subscribers.size > 0) {
        const sample = deriveMetricSample(this.#prev, probe, t);
        this.#prev = { t, probe };
        this.#cores = probe.cores;
        const frame = `data: ${JSON.stringify(sample)}\n\n`;
        for (const subscriber of [...this.#subscribers]) {
          this.#writeMeta(subscriber);
          this.#write(subscriber, frame);
        }
      }
    } finally {
      this.#ticking = false;
      this.#schedule(this.#intervalMs);
    }
  }

  async #probe(): Promise<MetricsProbe | null> {
    try {
      const result = await this.#runExec(
        "adb",
        ["-s", this.serial, "shell", METRICS_PROBE_SCRIPT],
        { timeout: METRICS_PROBE_TIMEOUT_MS, lane: "background" },
      );
      if (result.error) return null;
      return parseMetricsProbe(result.stdout);
    } catch {
      return null;
    }
  }
}
