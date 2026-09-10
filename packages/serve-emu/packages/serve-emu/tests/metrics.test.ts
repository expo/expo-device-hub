import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../src/exec.ts";
import {
  MetricsSampler,
  deriveMetricSample,
  parseMetricsProbe,
  type MetricsProbe,
} from "../src/metrics.ts";

const NET = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo: 160123577   48589    0    0    0     0          0         0 160123577   48589    0    0    0     0       0          0",
  "  eth0: 4563656    4635    0    0    0     0          0         0   253472    1135    0    0    0     0       0          0",
  " wlan0: 315405369  291595    0    0    0     0          0         0 23652167   96780    0    0    0     0       0          0",
].join("\n");

const MAPS = "com.google.android.apps.maps";

function procLines(
  packageName: string,
  { pid = "27093", utime = 3367, rss = 340668, comm = "droid.apps.maps" } = {},
) {
  return [
    `pkg ${packageName}`,
    `pid ${pid}`,
    `stat ${pid} (${comm}) S 449 449 0 0 -1 4194624 955035 0 20041 0 ${utime} 25845 0 0 10 -10 106 0 24944777 20191551488 85167 18446744073709551615 1 1 0 0 0 0 4612 1 1098945784 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0`,
    `rss VmRSS:\t  ${rss} kB`,
  ];
}

function probeText(
  overrides: {
    cpu?: string;
    pid?: string;
    utime?: number;
    rss?: number;
    comm?: string;
    fgwin?: string[];
    fgact?: string[];
    proc?: string[];
  } = {},
) {
  const {
    cpu = "932141 45478 2020577 94137975 45606 2982022 52833 0 0 0",
    pid = "27093",
    utime = 3367,
    rss = 340668,
    comm = "droid.apps.maps",
    fgwin = [`    mCurrentFocus=Window{9b3d4d5 u0 ${MAPS}/com.google.android.maps.MapsActivity}`],
    fgact = [
      `    topResumedActivity=ActivityRecord{132647058 u0 ${MAPS}/com.google.android.maps.MapsActivity t42}`,
    ],
    proc = procLines(MAPS, { pid, utime, rss, comm }),
  } = overrides;
  return [
    "---stat",
    `cpu  ${cpu}`,
    "4",
    "---fgwin",
    ...fgwin,
    "---fgact",
    ...fgact,
    "---proc",
    ...proc,
    "---net",
    NET,
    "",
  ].join("\n");
}

const NO_APP = [
  "---stat",
  "cpu  10 0 10 80 0 0 0 0 0 0",
  "2",
  "---fgwin",
  "",
  "---fgact",
  "",
  "---proc",
  "---net",
  NET,
  "",
].join("\n");

describe("parseMetricsProbe", () => {
  test("reads cores, ticks, foreground pid, rss and device-wide network", () => {
    expect(parseMetricsProbe(probeText())).toEqual({
      cores: 4,
      totalJiffies: 932141 + 45478 + 2020577 + 94137975 + 45606 + 2982022 + 52833,
      packageName: "com.google.android.apps.maps",
      pid: 27093,
      procJiffies: 3367 + 25845,
      rssBytes: 340668 * 1024,
      netRxBytes: 4563656 + 315405369,
      netTxBytes: 253472 + 23652167,
    });
  });

  test("leaves process fields null when no app is resumed", () => {
    expect(parseMetricsProbe(NO_APP)).toMatchObject({
      cores: 2,
      totalJiffies: 100,
      packageName: null,
      pid: null,
      procJiffies: null,
      rssBytes: null,
      netRxBytes: 4563656 + 315405369,
    });
  });

  test("ignores guest jiffies, which user and nice already include", () => {
    const withGuest = probeText({ cpu: "10 20 30 40 0 0 0 0 7 3" });
    expect(parseMetricsProbe(withGuest)!.totalJiffies).toBe(100);
  });

  test("reads a comm containing spaces and parentheses", () => {
    const probe = parseMetricsProbe(probeText({ comm: "Web Content (x)" }));
    expect(probe!.procJiffies).toBe(3367 + 25845);
  });

  test("prefers the window dump, as /api/foreground does", () => {
    const probe = parseMetricsProbe(
      probeText({
        fgwin: ["    mCurrentFocus=Window{9b3d4d5 u0 com.example.focused/.MainActivity}"],
        proc: [
          ...procLines("com.example.focused", { pid: "800", utime: 11, rss: 2048 }),
          ...procLines(MAPS, { pid: "27093" }),
        ],
      }),
    );
    expect(probe).toMatchObject({
      packageName: "com.example.focused",
      pid: 800,
      procJiffies: 11 + 25845,
      rssBytes: 2048 * 1024,
    });
  });

  test("falls back to the activity dump when no window line names a component", () => {
    const probe = parseMetricsProbe(probeText({ fgwin: ["    mCurrentFocus=null"] }));
    expect(probe).toMatchObject({ packageName: MAPS, pid: 27093 });
  });

  test("ignores a resumed-activity line the shared detector rejects", () => {
    const probe = parseMetricsProbe(
      probeText({
        fgwin: [""],
        fgact: [
          `    topResumedActivity=ActivityRecord{132647058 u0 ${MAPS}/com.google.android.maps.MapsActivity}`,
        ],
      }),
    );
    expect(probe).toMatchObject({ packageName: null, pid: null, rssBytes: null });
  });

  test("ranks the resumed-activity detectors by kind, not by line order", () => {
    const probe = parseMetricsProbe(
      probeText({
        fgwin: [""],
        fgact: [
          "    mResumedActivity: ActivityRecord{1 u0 com.example.earlier/.Home t1}",
          `    topResumedActivity=ActivityRecord{2 u0 ${MAPS}/com.google.android.maps.MapsActivity t42}`,
        ],
        proc: [
          ...procLines("com.example.earlier", { pid: "800" }),
          ...procLines(MAPS, { pid: "27093" }),
        ],
      }),
    );
    expect(probe).toMatchObject({ packageName: MAPS, pid: 27093 });
  });

  test("leaves process fields null when no candidate matches the foreground package", () => {
    const probe = parseMetricsProbe(probeText({ proc: procLines("com.example.other") }));
    expect(probe).toMatchObject({ packageName: MAPS, pid: null, procJiffies: null });
  });

  test("rejects output without a cpu line", () => {
    expect(parseMetricsProbe("")).toBeNull();
    expect(parseMetricsProbe("error: device offline")).toBeNull();
    expect(parseMetricsProbe("---stat\ncpu  1 2\nnot-a-number\n")).toBeNull();
  });
});

describe("deriveMetricSample", () => {
  const first = parseMetricsProbe(probeText())!;

  test("first sample carries identity and memory but zero rates", () => {
    expect(deriveMetricSample(null, first, 1000)).toEqual({
      t: 1000,
      bundleId: "com.google.android.apps.maps",
      cpuPct: 0,
      memBytes: 340668 * 1024,
      netInBytesPerSec: 0,
      netOutBytesPerSec: 0,
    });
  });

  test("cpu is per guest core from jiffy deltas; network is bytes per second", () => {
    const next: MetricsProbe = {
      ...first,
      totalJiffies: first.totalJiffies + 400,
      procJiffies: first.procJiffies! + 50,
      netRxBytes: first.netRxBytes + 3000,
      netTxBytes: first.netTxBytes + 500,
    };
    const sample = deriveMetricSample({ t: 1000, probe: first }, next, 3000);
    expect(sample.cpuPct).toBe(50);
    expect(sample.netInBytesPerSec).toBe(1500);
    expect(sample.netOutBytesPerSec).toBe(250);
  });

  test("pid change resets the cpu baseline but keeps network rates", () => {
    const next: MetricsProbe = {
      ...first,
      pid: 1,
      totalJiffies: first.totalJiffies + 400,
      procJiffies: 5,
      netRxBytes: first.netRxBytes + 1000,
    };
    const sample = deriveMetricSample({ t: 0, probe: first }, next, 1000);
    expect(sample.cpuPct).toBe(0);
    expect(sample.netInBytesPerSec).toBe(1000);
  });

  test("a counter going backwards clamps to zero", () => {
    const next: MetricsProbe = {
      ...first,
      totalJiffies: first.totalJiffies + 1,
      procJiffies: 0,
      netRxBytes: 0,
    };
    const sample = deriveMetricSample({ t: 0, probe: first }, next, 1000);
    expect(sample.cpuPct).toBe(0);
    expect(sample.netInBytesPerSec).toBe(0);
  });
});

function execResult(stdout: string): ExecResult<string> {
  return { status: 0, signal: null, stdout, stderr: "", timedOut: false, error: null };
}

async function readFrames(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: string[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end >= 0 && frames.length < count) {
      frames.push(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
    }
  }
  reader.releaseLock();
  return frames;
}

describe("MetricsSampler", () => {
  function sampler() {
    const calls: { args: string[]; lane: string | undefined }[] = [];
    let tick = 0;
    const instance = new MetricsSampler({
      serial: "emulator-5554",
      intervalMs: 5,
      now: () => tick * 1000,
      runExec: async (_cmd, args, opts) => {
        calls.push({ args, lane: opts?.lane });
        tick += 1;
        return execResult(
          probeText({ utime: 3367 + tick * 100, cpu: `${tick * 400} 0 0 0 0 0 0 0 0 0` }),
        );
      },
    });
    return { instance, calls };
  }

  test("streams a comment, meta after the first probe, then samples", async () => {
    const { instance, calls } = sampler();
    const controller = new AbortController();
    const response = instance.subscribe(controller.signal);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");

    const [comment, meta, first, second] = await readFrames(response, 4);
    expect(comment).toBe(":");
    expect(meta).toBe(
      'event: meta\ndata: {"schemaVersion":1,"udid":"emulator-5554","hostCores":4,"sampleIntervalMs":5}',
    );
    expect(JSON.parse(first!.slice("data: ".length))).toMatchObject({
      bundleId: "com.google.android.apps.maps",
      cpuPct: 0,
      memBytes: 340668 * 1024,
    });
    expect(JSON.parse(second!.slice("data: ".length)).cpuPct).toBe(100);
    expect(calls[0]!.args.slice(0, 3)).toEqual(["-s", "emulator-5554", "shell"]);
    expect(calls.map((call) => call.lane)).toEqual(calls.map(() => "background"));

    controller.abort();
    await Bun.sleep(30);
    const settled = calls.length;
    await Bun.sleep(30);
    expect(calls.length).toBe(settled);
    expect(instance.subscriberCount).toBe(0);
    expect(instance.running).toBe(false);
  });

  test("a later subscriber gets meta immediately and the loop stays single", async () => {
    const { instance, calls } = sampler();
    const a = new AbortController();
    const first = instance.subscribe(a.signal);
    await readFrames(first, 3);
    const b = new AbortController();
    const [comment, meta] = await readFrames(instance.subscribe(b.signal), 2);
    expect(comment).toBe(":");
    expect(meta!.startsWith("event: meta\n")).toBe(true);
    expect(instance.subscriberCount).toBe(2);

    a.abort();
    const before = calls.length;
    await Bun.sleep(40);
    const during = calls.length - before;
    b.abort();
    await Bun.sleep(20);
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThanOrEqual(10);
    expect(instance.running).toBe(false);
  });

  test("a pending probe blocks the next tick and a joiner reuses it", async () => {
    let pending: ((result: ExecResult<string>) => void) | null = null;
    let started = 0;
    const instance = new MetricsSampler({
      serial: "emulator-5554",
      intervalMs: 1,
      runExec: () => {
        started += 1;
        return new Promise<ExecResult<string>>((resolve) => {
          pending = resolve;
        });
      },
    });
    const a = new AbortController();
    const first = instance.subscribe(a.signal);
    await Bun.sleep(20);
    expect(started).toBe(1);

    const b = new AbortController();
    const second = instance.subscribe(b.signal);
    await Bun.sleep(20);
    expect(started).toBe(1);
    expect(instance.subscriberCount).toBe(2);

    pending!(execResult(probeText()));
    const [, , firstSample] = await readFrames(first, 3);
    const [, , secondSample] = await readFrames(second, 3);
    expect(firstSample).toBe(secondSample!);
    expect(firstSample!.startsWith("data: ")).toBe(true);

    a.abort();
    b.abort();
    await Bun.sleep(10);
    expect(instance.running).toBe(false);
  });

  test("close during a pending probe stops the loop", async () => {
    let started = 0;
    const instance = new MetricsSampler({
      serial: "emulator-5554",
      intervalMs: 1,
      runExec: () => {
        started += 1;
        return new Promise<ExecResult<string>>((resolve) =>
          setTimeout(() => resolve(execResult(probeText())), 15),
        );
      },
    });
    instance.subscribe();
    await Bun.sleep(5);
    instance.close();
    await Bun.sleep(40);
    expect(started).toBe(1);
    expect(instance.running).toBe(false);
    expect(instance.subscriberCount).toBe(0);
  });

  test("cancelling the consumer drops the subscriber", async () => {
    const { instance } = sampler();
    const response = instance.subscribe();
    await readFrames(response, 2);
    await response.body!.cancel();
    await Bun.sleep(20);
    expect(instance.subscriberCount).toBe(0);
    expect(instance.running).toBe(false);
  });

  test("close ends open streams and refuses new subscribers", async () => {
    const { instance } = sampler();
    const response = instance.subscribe();
    await readFrames(response, 2);
    instance.close();
    const reader = response.body!.getReader();
    let done = false;
    while (!done) done = (await reader.read()).done;
    expect(instance.subscribe().status).toBe(409);
    const aborted = new AbortController();
    aborted.abort();
    expect(new MetricsSampler({ serial: "x" }).subscribe(aborted.signal).status).toBe(499);
  });

  test("a failed probe skips the tick without ending the stream", async () => {
    let n = 0;
    const instance = new MetricsSampler({
      serial: "emulator-5554",
      intervalMs: 5,
      runExec: async () => {
        n += 1;
        return n === 1
          ? { ...execResult(""), status: 1, error: new Error("adb: device offline") }
          : execResult(probeText());
      },
    });
    const controller = new AbortController();
    const frames = await readFrames(instance.subscribe(controller.signal), 3);
    expect(frames[1]!.startsWith("event: meta")).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
    controller.abort();
  });
});
