// TEST BUILD ONLY. A host-wide process sample on the /metrics stream, so a real EAS session's
// metrics artifact shows which host processes run next to serve-sim (Device Hub, Simulator.app)
// and what CPU and GPU they use. Each sample is an `event: host` frame; the EAS metrics poller
// writes it to the NDJSON as a line with `"kind":"host"`. The preview panel listens to unnamed
// messages only, so it ignores these frames.

import { execFile } from "node:child_process";
import { loadavg } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HOST_APP_NAMES = ["DeviceHub", "Simulator"];
const TOP_PROCESSES = 20;
const TOP_GPU_CLIENTS = 10;

export interface HostProcess {
  pid: number;
  name: string;
  cpuPct: number; // over the interval since the previous sample, per core (can exceed 100)
  rssMb: number;
}

export interface HostGpuClient {
  pid: number;
  name: string;
  gpuMs: number; // GPU time used over the interval since the previous sample
}

export interface HostProcessSample {
  kind: "host";
  t: number; // ms since the sampler started
  intervalMs: number;
  loadAvg1m: number;
  hostApps: { name: string; pid: number; cpuPct: number; gpuMs: number | null }[];
  top: HostProcess[];
  gpu: {
    deviceUtilizationPct: number | null;
    rendererUtilizationPct: number | null;
    clients: HostGpuClient[];
  };
}

interface PsRow {
  pid: number;
  name: string;
  cpuSeconds: number;
  rssKb: number;
}

/** `ps` cputime is `[HH:]MM:SS.ss` cumulative CPU time. */
function cputimeToSeconds(cputime: string): number {
  return cputime.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

export function parsePsRows(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+([\d:.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: +m[1]!, cpuSeconds: cputimeToSeconds(m[2]!), rssKb: +m[3]!, name: m[4]!.split("/").pop()! });
  }
  return rows;
}

/** Accumulated GPU time (ns) per client pid, summed over its AppUsage entries, plus the utilization. */
export function parseIoregGpu(output: string): {
  deviceUtilizationPct: number | null;
  rendererUtilizationPct: number | null;
  clients: Map<number, { name: string; gpuNs: number }>;
} {
  const pct = (key: string): number | null => {
    const m = new RegExp(`"${key}"=(\\d+)`).exec(output);
    return m ? Number(m[1]) : null;
  };
  const clients = new Map<number, { name: string; gpuNs: number }>();
  let creator: { pid: number; name: string } | null = null;
  for (const line of output.split("\n")) {
    const c = /"IOUserClientCreator" = "pid (\d+), ([^"]+)"/.exec(line);
    if (c) creator = { pid: +c[1]!, name: c[2]! };
    if (creator && line.includes('"AppUsage"')) {
      const entry = clients.get(creator.pid) ?? { name: creator.name, gpuNs: 0 };
      for (const g of line.matchAll(/"accumulatedGPUTime"=(\d+)/g)) entry.gpuNs += Number(g[1]);
      clients.set(creator.pid, entry);
    }
  }
  return {
    deviceUtilizationPct: pct("Device Utilization %"),
    rendererUtilizationPct: pct("Renderer Utilization %"),
    clients,
  };
}

export interface HostSamplerDeps {
  exec?: (file: string, args: string[]) => Promise<string>;
  now?: () => number;
  intervalMs?: number;
}

/** Samples every host process and GPU client; shared by every /metrics stream, ref-counted. */
export class HostProcessSampler {
  private readonly exec: (file: string, args: string[]) => Promise<string>;
  private readonly now: () => number;
  readonly intervalMs: number;
  private readonly listeners = new Set<(sample: HostProcessSample) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt: number | null = null;
  private prev: { t: number; cpu: Map<number, number>; gpu: Map<number, number> } | null = null;

  constructor(deps: HostSamplerDeps = {}) {
    this.exec =
      deps.exec ??
      ((file, args) =>
        execFileAsync(file, args, { timeout: 5000, maxBuffer: 32 * 1024 * 1024 }).then((r) => r.stdout));
    this.now = deps.now ?? (() => performance.now());
    this.intervalMs = deps.intervalMs ?? 5000;
  }

  subscribe(listener: (sample: HostProcessSample) => void): () => void {
    this.listeners.add(listener);
    if (!this.timer) this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  private schedule(): void {
    // The first sample only sets the baseline, so it runs right away; the next one reports.
    const delay = this.prev ? this.intervalMs : 0;
    const timer = setTimeout(async () => {
      const sample = await this.tickOnce().catch(() => null);
      if (this.timer !== timer) return;
      if (sample) {
        for (const listener of this.listeners) {
          try {
            listener(sample);
          } catch {
            // A closed stream must not starve the others.
          }
        }
      }
      this.schedule();
    }, delay);
    this.timer = timer;
  }

  /** One reading; null for the first one, which has no baseline for the interval deltas. */
  async tickOnce(): Promise<HostProcessSample | null> {
    this.startedAt ??= this.now();
    const t = this.now() - this.startedAt;
    const [psOutput, ioregOutput] = await Promise.all([
      this.exec("ps", ["-axo", "pid=,cputime=,rss=,comm="]),
      this.exec("ioreg", ["-r", "-c", "IOAccelerator", "-l", "-w0"]).catch(() => ""),
    ]);
    const rows = parsePsRows(psOutput);
    const gpu = parseIoregGpu(ioregOutput);
    const cpu = new Map(rows.map((r) => [r.pid, r.cpuSeconds]));
    const gpuNs = new Map([...gpu.clients].map(([pid, c]) => [pid, c.gpuNs]));
    const prev = this.prev;
    this.prev = { t, cpu, gpu: gpuNs };
    if (!prev || t <= prev.t) return null;

    const seconds = (t - prev.t) / 1000;
    const cpuPct = (pid: number, now: number): number => {
      const before = prev.cpu.get(pid);
      return before == null || now < before ? 0 : +(((now - before) / seconds) * 100).toFixed(1);
    };
    const gpuMs = (pid: number): number | null => {
      const now = gpuNs.get(pid);
      if (now == null) return null;
      const before = prev.gpu.get(pid) ?? now;
      return now < before ? 0 : +((now - before) / 1e6).toFixed(1);
    };

    const processes = rows.map((r) => ({
      pid: r.pid,
      name: r.name,
      cpuPct: cpuPct(r.pid, r.cpuSeconds),
      rssMb: Math.round(r.rssKb / 1024),
    }));
    return {
      kind: "host",
      t: Math.round(t),
      intervalMs: Math.round(t - prev.t),
      loadAvg1m: +loadavg()[0]!.toFixed(2),
      hostApps: processes
        .filter((p) => HOST_APP_NAMES.includes(p.name))
        .map((p) => ({ name: p.name, pid: p.pid, cpuPct: p.cpuPct, gpuMs: gpuMs(p.pid) })),
      top: processes.sort((a, b) => b.cpuPct - a.cpuPct).slice(0, TOP_PROCESSES),
      gpu: {
        deviceUtilizationPct: gpu.deviceUtilizationPct,
        rendererUtilizationPct: gpu.rendererUtilizationPct,
        clients: [...gpu.clients]
          .map(([pid, c]) => ({ pid, name: c.name, gpuMs: gpuMs(pid) ?? 0 }))
          .sort((a, b) => b.gpuMs - a.gpuMs)
          .slice(0, TOP_GPU_CLIENTS),
      },
    };
  }
}

export const hostProcessSampler = new HostProcessSampler();
