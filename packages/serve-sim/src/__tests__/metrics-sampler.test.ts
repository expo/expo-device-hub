import { describe, expect, it } from "bun:test";

import {
  createMetricsSamplerCache,
  findUserAppProcesses,
  MetricsSampler,
  netRatesFromSamples,
  NetworkThroughputMonitor,
  parseNetSampleByPid,
  sampleUserApp,
  sumPhysFootprintBytes,
  type MetricSample,
} from "../metrics-sampler";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";

// `ps -axo pid= cputime= rss= comm=` — the executable path of each process. The user app and its
// extension run from the sim's Containers/Bundle/Application path; launchd_sim and a RuntimeRoot
// daemon do not, and an unrelated host process is off-device. Matching on comm= (not args=) means a
// host tool that merely passes a sim bundle path as an argument never reports one here. Only the
// first two count. cputime is cumulative.
function psFixture(): string {
  return [
    `  101   0:00.10  15000 launchd_sim /x/Devices/${UDID}/data/var/run/launchd_bootstrap.plist`,
    `  102   0:40.00  32000 /Runtime/RuntimeRoot/System/Library/PrivateFrameworks/ApplePushService.framework/apsd`,
    `  103   0:12.00  80000 /x/Devices/${UDID}/data/Containers/Bundle/Application/AAA/MyApp.app/MyApp`,
    `  104   0:03.00  20000 /x/Devices/${UDID}/data/Containers/Bundle/Application/AAA/MyApp.app/PlugIns/Share.appex/Share`,
    `  105   0:09.90 999999 /some/host/process --unrelated`,
  ].join("\n");
}

// A second user app ("Two Words.app", a space in its path like real "Expo Go.app") on the same sim.
function psFixtureTwoApps(): string {
  return [
    psFixture(),
    `  106   0:02.00  50000 /x/Devices/${UDID}/data/Containers/Bundle/Application/BBB/Two Words.app/Two Words`,
  ].join("\n");
}

// One `nettop -x -P` CSV sample block: a header then one row per process ("name.pid", cumulative bytes).
function netFixture(rows: Array<{ pid: number; bytesIn: number; bytesOut: number }>): string {
  const header = "time,,interface,state,bytes_in,bytes_out";
  const body = rows.map((r) => `00:00:00.0,Proc.${r.pid},en0,Established,${r.bytesIn},${r.bytesOut}`);
  return [header, ...body].join("\n");
}

describe("findUserAppProcesses", () => {
  it("scopes to the frontmost app's bundle (host + extensions), ignoring other user/system apps", () => {
    // frontmost pid 103 -> MyApp.app; sums MyApp (12s) + its Share extension (3s), not the other app
    expect(findUserAppProcesses(psFixtureTwoApps(), UDID, 103)).toEqual({
      pids: [103, 104],
      cpuSeconds: 15,
      rssKb: 80000 + 20000,
    });
    // frontmost is the space-named app -> just that bundle
    expect(findUserAppProcesses(psFixtureTwoApps(), UDID, 106)).toEqual({
      pids: [106],
      cpuSeconds: 2,
      rssKb: 50000,
    });
  });

  it("matches the device path case-insensitively", () => {
    const ps = `7 0:02.00 1000 /x/Devices/${UDID.toLowerCase()}/data/Containers/Bundle/Application/AAA/App.app/App`;
    expect(findUserAppProcesses(ps, UDID, 7)).toEqual({ pids: [7], cpuSeconds: 2, rssKb: 1000 });
  });

  it("sums every user app when the frontmost pid is unknown or not a user app", () => {
    // no frontmost pid, or one that isn't a user process -> aggregate all user apps
    for (const pid of [undefined, 999999]) {
      expect(findUserAppProcesses(psFixtureTwoApps(), UDID, pid)).toEqual({
        pids: [103, 104, 106],
        cpuSeconds: 15 + 2,
        rssKb: 80000 + 20000 + 50000,
      });
    }
  });

  it("returns null when no user app is running on this sim", () => {
    // right sim, but only a system process (no Containers/Bundle path)
    expect(
      findUserAppProcesses(`1 0.1 15000 launchd_sim /x/Devices/${UDID}/data/var/run/x.plist\n`, UDID),
    ).toBeNull();
    expect(findUserAppProcesses("", UDID)).toBeNull();
  });
});

describe("sumPhysFootprintBytes", () => {
  // `footprint --noCategories --format bytes <pid> <pid>` output shape
  const footprintFixture = [
    "======================================================================",
    "MyApp [103]: 64-bit    Footprint: 253904480 B (16384 bytes per page)",
    "======================================================================",
    "",
    "Auxiliary data:",
    "    phys_footprint: 253937248 B",
    "    phys_footprint_peak: 333989448 B",
    "",
    "======================================================================",
    "Share [104]: 64-bit    Footprint: 2244968 B (16384 bytes per page)",
    "======================================================================",
    "",
    "Auxiliary data:",
    "    phys_footprint: 2261352 B",
    "    phys_footprint_peak: 2310504 B",
    "",
    "======================================================================",
    "Summary Footprint: 256100296 B",
    "======================================================================",
  ].join("\n");

  it("sums per-process phys_footprint, ignoring peaks and the summary", () => {
    expect(sumPhysFootprintBytes(footprintFixture)).toBe(253937248 + 2261352);
  });

  it("returns null when no process was reported", () => {
    expect(sumPhysFootprintBytes("")).toBeNull();
    expect(sumPhysFootprintBytes("footprint: Unable to find pid for process matching '9'")).toBeNull();
  });
});

describe("parseNetSampleByPid", () => {
  it("maps bytes_in / bytes_out to a per-pid in/out pair", () => {
    const byPid = parseNetSampleByPid(
      netFixture([
        { pid: 103, bytesIn: 500, bytesOut: 300 },
        { pid: 104, bytesIn: 100, bytesOut: 100 },
      ]),
    );
    expect(byPid.get(103)).toEqual({ netInBytesPerSec: 500, netOutBytesPerSec: 300 });
    expect(byPid.get(104)).toEqual({ netInBytesPerSec: 100, netOutBytesPerSec: 100 });
    expect(byPid.get(999)).toBeUndefined();
  });

  it("returns an empty map for a block without byte columns", () => {
    expect(parseNetSampleByPid("").size).toBe(0);
    expect(parseNetSampleByPid("time,,interface,state\n00:00,Proc.103,en0,x").size).toBe(0);
  });
});

// A `nettop -d -L 2` run: a cumulative-since-start first block, then per-interval blocks.
function netRun(samples: Array<Array<{ pid: number; bytesIn: number; bytesOut: number }>>): string {
  return samples.map((rows) => netFixture(rows)).join("\n");
}

describe("netRatesFromSamples", () => {
  it("reads the run's last sample as that interval's per-pid bytes/s", () => {
    const rate = netRatesFromSamples(
      netRun([
        // cumulative since each process started -> not a rate, ignored
        [{ pid: 42, bytesIn: 900_000, bytesOut: 400_000 }, { pid: 7, bytesIn: 500, bytesOut: 0 }],
        [{ pid: 42, bytesIn: 500, bytesOut: 200 }, { pid: 7, bytesIn: 0, bytesOut: 0 }],
      ]),
    );
    expect(rate.get(42)).toEqual({ netInBytesPerSec: 500, netOutBytesPerSec: 200 });
    expect(rate.get(7)).toEqual({ netInBytesPerSec: 0, netOutBytesPerSec: 0 }); // idle this interval, reported as zero
  });

  it("keeps a busy process's rate when one of its connections closes", () => {
    // `-d` counts only what moved during the interval, so a closing connection can't drag the
    // process's total backwards and zero out its other, still-active transfers.
    const rate = netRatesFromSamples(
      netRun([
        [{ pid: 42, bytesIn: 5000, bytesOut: 0 }],
        [{ pid: 42, bytesIn: 1000, bytesOut: 0 }],
      ]),
    );
    expect(rate.get(42)).toEqual({ netInBytesPerSec: 1000, netOutBytesPerSec: 0 });
  });

  it("returns empty when a run produced only the cumulative first sample", () => {
    expect(netRatesFromSamples(netFixture([{ pid: 1, bytesIn: 1, bytesOut: 1 }])).size).toBe(0);
  });
});

describe("NetworkThroughputMonitor", () => {
  function controllableNettop() {
    const calls: Array<{
      resolve: (out: string) => void;
      reject: (err: Error) => void;
    }> = [];
    const run = (_signal?: AbortSignal): Promise<string> =>
      new Promise((resolve, reject) => calls.push({ resolve, reject }));
    return { run, calls };
  }

  async function until(pred: () => boolean, budgetMs = 500): Promise<void> {
    for (let waited = 0; !pred() && waited < budgetMs; waited += 5) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (!pred()) throw new Error("condition not met within budget");
  }

  const netWindow = (bytesIn: number): string =>
    netRun([
      [{ pid: 42, bytesIn: 900_000, bytesOut: 0 }],
      [{ pid: 42, bytesIn, bytesOut: 0 }],
    ]);

  it("polls nettop in a loop and exposes the latest per-pid rate, cleared on stop", async () => {
    const { run, calls } = controllableNettop();
    const monitor = new NetworkThroughputMonitor(run);

    monitor.start();
    await until(() => calls.length === 1); // first run in flight
    calls[0]!.resolve(netWindow(2000));
    await until(() => monitor.rateForPids([42]).netInBytesPerSec === 2000);
    expect(monitor.rateForPids([42])).toEqual({ netInBytesPerSec: 2000, netOutBytesPerSec: 0 });
    await until(() => calls.length === 2); // loops for the next window

    monitor.stop();
    expect(monitor.rateForPids([42])).toEqual({ netInBytesPerSec: 0, netOutBytesPerSec: 0 }); // the live pid's rate is cleared on stop
  });

  it("drops a pid's rate when its next window is idle, rather than replaying the stale value", async () => {
    const { run, calls } = controllableNettop();
    const monitor = new NetworkThroughputMonitor(run);

    monitor.start();
    await until(() => calls.length === 1);
    calls[0]!.resolve(netWindow(2000)); // busy interval
    await until(() => monitor.rateForPids([42]).netInBytesPerSec === 2000);

    await until(() => calls.length === 2);
    calls[1]!.resolve(netWindow(0)); // idle interval
    await until(() => monitor.rateForPids([42]).netInBytesPerSec === 0);
    expect(monitor.rateForPids([42])).toEqual({ netInBytesPerSec: 0, netOutBytesPerSec: 0 });

    monitor.stop();
  });

  it("a run resolving after stop()+start() neither writes its rate nor spawns a second loop", async () => {
    const { run, calls } = controllableNettop();
    const monitor = new NetworkThroughputMonitor(run);

    monitor.start();
    await until(() => calls.length === 1);
    monitor.stop();
    monitor.start();
    await until(() => calls.length === 2);

    calls[0]!.resolve(netWindow(9999));
    await new Promise((r) => setTimeout(r, 5));
    expect(monitor.rateForPids([42])).toEqual({ netInBytesPerSec: 0, netOutBytesPerSec: 0 });

    calls[1]!.resolve(netWindow(2000));
    await until(() => monitor.rateForPids([42]).netInBytesPerSec === 2000);
    await until(() => calls.length === 3);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(3);

    monitor.stop();
  });

  it("clears rates when a nettop run fails", async () => {
    const { run, calls } = controllableNettop();
    const monitor = new NetworkThroughputMonitor(run);

    monitor.start();
    await until(() => calls.length === 1);
    calls[0]!.resolve(netWindow(2000));
    await until(() => monitor.rateForPids([42]).netInBytesPerSec === 2000);

    await until(() => calls.length === 2);
    calls[1]!.reject(new Error("nettop gone"));
    await until(() => monitor.rateForPids([42]).netInBytesPerSec === 0);
    expect(monitor.rateForPids([42])).toEqual({ netInBytesPerSec: 0, netOutBytesPerSec: 0 });

    monitor.stop();
  });
});

describe("sampleUserApp", () => {
  const footprintFor = (pids: string[]): string =>
    pids.map((pid) => `App [${pid}]:\nAuxiliary data:\n    phys_footprint: 1000000 B\n`).join("\n");

  const frontmost = (pid: number, bundleId = "dev.expo.MyApp") => async () => ({ pid, bundleId });

  it("combines ps (cpu), footprint (mem), and the network rate for the frontmost app", async () => {
    const seen: string[] = [];
    const exec = async (file: string, args: string[]): Promise<string> => {
      seen.push(file);
      if (file === "ps") return psFixtureTwoApps();
      const pids = args.filter((a) => /^\d+$/.test(a));
      expect(pids).toEqual(["103", "104"]); // footprint receives the frontmost app's pids
      return footprintFor(pids);
    };
    let ratePids: number[] = [];
    const networkRate = (pids: number[]): { netInBytesPerSec: number; netOutBytesPerSec: number } => {
      ratePids = pids;
      return { netInBytesPerSec: 1000, netOutBytesPerSec: 234 };
    };
    const usage = await sampleUserApp(UDID, {
      exec,
      frontmostApp: frontmost(103, "dev.expo.MyApp"),
      networkRate,
    });
    expect(usage).toEqual({
      bundleId: "dev.expo.MyApp",
      processKey: "103,104",
      cpuSeconds: 15, // MyApp (12) + its extension (3)
      memBytes: 2_000_000,
      netInBytesPerSec: 1000,
      netOutBytesPerSec: 234,
    });
    expect(ratePids).toEqual([103, 104]);
    expect(seen.sort()).toEqual(["footprint", "ps"]);
  });

  it("falls back to RSS bytes and zero network when footprint fails and no rate is provided", async () => {
    const exec = async (file: string): Promise<string> => {
      if (file === "ps") return psFixture();
      throw new Error(`${file} exited non-zero`);
    };
    const usage = await sampleUserApp(UDID, { exec, frontmostApp: frontmost(103) });
    expect(usage).toEqual({
      bundleId: "dev.expo.MyApp",
      processKey: "103,104",
      cpuSeconds: 15,
      memBytes: (80000 + 20000) * 1024,
      netInBytesPerSec: 0,
      netOutBytesPerSec: 0,
    });
  });

  it("tags bundleId null and covers all user apps when nothing user-facing is foreground", async () => {
    const exec = async (file: string, args: string[]): Promise<string> =>
      file === "ps" ? psFixtureTwoApps() : footprintFor(args.filter((a) => /^\d+$/.test(a)));
    // AX unavailable -> no frontmost app: sum all user apps (103 + 104 + 106), bundleId null
    const networkRate = () => ({ netInBytesPerSec: 55, netOutBytesPerSec: 0 });
    expect(await sampleUserApp(UDID, { exec, frontmostApp: async () => null, networkRate })).toEqual({
      bundleId: null,
      processKey: "103,104,106",
      cpuSeconds: 17,
      memBytes: 3_000_000,
      netInBytesPerSec: 55,
      netOutBytesPerSec: 0,
    });
    // a system app is frontmost (pid not among the user-app processes) -> same
    expect(await sampleUserApp(UDID, { exec, frontmostApp: frontmost(999999), networkRate })).toEqual({
      bundleId: null,
      processKey: "103,104,106",
      cpuSeconds: 17,
      memBytes: 3_000_000,
      netInBytesPerSec: 55,
      netOutBytesPerSec: 0,
    });
  });

  it("returns null when no user app is running or ps fails", async () => {
    const psFails = async (): Promise<string> => {
      throw new Error("ps exited non-zero");
    };
    expect(await sampleUserApp(UDID, { exec: psFails, frontmostApp: frontmost(103) })).toBeNull();
    // ps succeeds but only system processes are present
    const systemOnly = async (file: string): Promise<string> =>
      file === "ps" ? `1 0.1 15000 launchd_sim /x/Devices/${UDID}/data/var/run/x.plist` : "";
    expect(await sampleUserApp(UDID, { exec: systemOnly, frontmostApp: async () => null })).toBeNull();
  });
});

describe("MetricsSampler", () => {
  function fakeClock(step = 1000): () => number {
    let t = 0;
    return () => {
      const v = t;
      t += step;
      return v;
    };
  }

  it("exposes meta (schema, udid, hostCores, interval)", () => {
    const sampler = new MetricsSampler({ udid: UDID, intervalMs: 500, hostCores: 8 });
    expect(sampler.meta).toEqual({
      schemaVersion: 1,
      udid: UDID,
      hostCores: 8,
      sampleIntervalMs: 500,
    });
  });

  it("stamps deviceName into meta when supplied", () => {
    const sampler = new MetricsSampler({ udid: UDID, deviceName: "iPhone 15", hostCores: 8 });
    expect(sampler.meta.deviceName).toBe("iPhone 15");
  });

  it("omits deviceName from meta (and the serialized frame) when not supplied", () => {
    const sampler = new MetricsSampler({ udid: UDID, hostCores: 8 });
    expect(sampler.meta.deviceName).toBeUndefined();
    // JSON.stringify drops undefined, so the SSE meta frame carries no deviceName key.
    expect("deviceName" in JSON.parse(JSON.stringify(sampler.meta))).toBe(false);
  });

  it("derives cpuPct from the cpu-time delta and passes the network rate through", async () => {
    // Cumulative cpu-seconds per tick, 1s spacing. Expected cpuPct: t1 no baseline -> 0; t2 +0.5s -> 50;
    // t3 drop (churn) -> clamped 0; t4 app switch (B) -> 0; t5 +0.6s -> 60. netBytesPerSec is already a
    // rate from the nettop stream, so it flows through unchanged.
    const readings = [
      { bundleId: "dev.expo.A", processKey: "1", cpuSeconds: 10.0, memBytes: 100, netInBytesPerSec: 0, netOutBytesPerSec: 0 },
      { bundleId: "dev.expo.A", processKey: "1", cpuSeconds: 10.5, memBytes: 400, netInBytesPerSec: 2000, netOutBytesPerSec: 0 },
      { bundleId: "dev.expo.A", processKey: "1", cpuSeconds: 10.4, memBytes: 250, netInBytesPerSec: 0, netOutBytesPerSec: 0 },
      { bundleId: "dev.expo.B", processKey: "2", cpuSeconds: 99.0, memBytes: 260, netInBytesPerSec: 10, netOutBytesPerSec: 0 },
      { bundleId: "dev.expo.B", processKey: "2", cpuSeconds: 99.6, memBytes: 270, netInBytesPerSec: 600, netOutBytesPerSec: 0 },
    ];
    let i = 0;
    const sampler = new MetricsSampler({
      udid: UDID,
      sample: async () => readings[i++]!,
      now: fakeClock(),
      hostCores: 8,
    });
    const got: MetricSample[] = [];
    sampler.onSample((s) => got.push(s));

    for (let n = 0; n < readings.length; n++) await sampler.tickOnce();

    expect(got).toEqual([
      { t: 1000, bundleId: "dev.expo.A", cpuPct: 0, memBytes: 100, netInBytesPerSec: 0, netOutBytesPerSec: 0 },
      { t: 2000, bundleId: "dev.expo.A", cpuPct: 50, memBytes: 400, netInBytesPerSec: 2000, netOutBytesPerSec: 0 },
      { t: 3000, bundleId: "dev.expo.A", cpuPct: 0, memBytes: 250, netInBytesPerSec: 0, netOutBytesPerSec: 0 },
      { t: 4000, bundleId: "dev.expo.B", cpuPct: 0, memBytes: 260, netInBytesPerSec: 10, netOutBytesPerSec: 0 },
      { t: 5000, bundleId: "dev.expo.B", cpuPct: 60, memBytes: 270, netInBytesPerSec: 600, netOutBytesPerSec: 0 },
    ]);
    sampler.stop();
  });

  it("resets the cpu baseline when the process set changes within the same app", async () => {
    // Same bundle, but the pid set changes (relaunch / extension swap) at t3. Cumulative CPU isn't
    // comparable across process sets, so the delta must reset rather than report a false spike.
    const readings = [
      { bundleId: "dev.expo.A", processKey: "1", cpuSeconds: 10, memBytes: 100, netInBytesPerSec: 0, netOutBytesPerSec: 0 },
      { bundleId: "dev.expo.A", processKey: "1", cpuSeconds: 10.5, memBytes: 100, netInBytesPerSec: 0, netOutBytesPerSec: 0 },
      { bundleId: "dev.expo.A", processKey: "2", cpuSeconds: 99, memBytes: 100, netInBytesPerSec: 0, netOutBytesPerSec: 0 },
    ];
    let i = 0;
    const sampler = new MetricsSampler({ udid: UDID, sample: async () => readings[i++]!, now: fakeClock(), hostCores: 8 });
    const got: MetricSample[] = [];
    sampler.onSample((s) => got.push(s));

    for (let n = 0; n < readings.length; n++) await sampler.tickOnce();

    expect(got.map((s) => s.cpuPct)).toEqual([0, 50, 0]); // t3 resets despite the unchanged bundleId
    sampler.stop();
  });

  it("anchors the CPU delta to the observation time, not after the slow memory probe", async () => {
    let clockMs = 0;
    const now = () => clockMs;
    const readings = [
      { bundleId: "dev.expo.A", processKey: "1", cpuSeconds: 10, memBytes: 100, netInBytesPerSec: 0, netOutBytesPerSec: 0 },
      { bundleId: "dev.expo.A", processKey: "1", cpuSeconds: 10.5, memBytes: 100, netInBytesPerSec: 0, netOutBytesPerSec: 0 },
    ];
    let i = 0;
    let footprintMs = 0;
    // sample() reads cpu up front, then the footprint probe takes `footprintMs` before returning.
    const sample = async (): Promise<(typeof readings)[number]> => {
      const reading = readings[i++]!;
      clockMs += footprintMs;
      return reading;
    };
    const sampler = new MetricsSampler({ udid: UDID, sample, now, hostCores: 8 });
    const got: MetricSample[] = [];
    sampler.onSample((s) => got.push(s));

    footprintMs = 0;
    await sampler.tickOnce(); // baseline
    clockMs += 1000; // 1s until the next observation
    footprintMs = 1000; // this tick's footprint probe is slow
    await sampler.tickOnce();

    // 0.5 cpu-seconds over the 1s observation interval = 50%, unaffected by the 1s footprint latency
    // (which used to inflate the denominator and would report 25% here).
    expect(got.at(-1)!.cpuPct).toBe(50);
    sampler.stop();
  });

  it("skips a tick when the sim isn't up (null reading)", async () => {
    const sampler = new MetricsSampler({
      udid: UDID,
      sample: async () => null,
      now: fakeClock(),
      hostCores: 8,
    });
    const got: MetricSample[] = [];
    sampler.onSample((s) => got.push(s));
    expect(await sampler.tickOnce()).toBeNull();
    expect(got).toHaveLength(0);
  });

  it("keeps notifying later listeners when an earlier one throws", async () => {
    const sampler = new MetricsSampler({
      udid: UDID,
      sample: async () => ({ bundleId: "dev.expo.A", processKey: "1", cpuSeconds: 1, memBytes: 2, netInBytesPerSec: 0, netOutBytesPerSec: 0 }),
      now: fakeClock(),
      hostCores: 8,
    });
    const received: MetricSample[] = [];
    sampler.onSample(() => {
      throw new Error("subscriber blew up");
    });
    sampler.onSample((s) => received.push(s));
    await sampler.tickOnce();
    expect(received).toHaveLength(1);
  });

  it("does not spawn overlapping poll loops on a stop/start during a tick", async () => {
    const intervalMs = 30;
    let ticks = 0;
    let releaseFirstTick!: () => void;
    const firstTickGate = new Promise<void>((resolve) => (releaseFirstTick = resolve));
    const sample = async () => {
      ticks++;
      if (ticks === 1) await firstTickGate; // hold the first tick open across the stop/start
      return null;
    };
    const sampler = new MetricsSampler({ udid: UDID, sample, intervalMs, hostCores: 8 });

    sampler.start();
    for (let waited = 0; ticks < 1 && waited < 500; waited += 5) {
      await new Promise((r) => setTimeout(r, 5)); // wait until the first tick is in flight
    }
    expect(ticks).toBe(1);

    // Restart while the tick is still awaiting; the superseded loop must not reschedule.
    sampler.stop();
    sampler.start();
    releaseFirstTick();
    await new Promise((r) => setTimeout(r, 5)); // flush the old loop's continuation
    sampler.stop();

    const ticksAtStop = ticks;
    await new Promise((r) => setTimeout(r, intervalMs * 3)); // an orphaned loop would fire here
    expect(ticks).toBe(ticksAtStop);
  });
});

describe("createMetricsSamplerCache", () => {
  it("shares one sampler across subscribers for the same udid and stops it on last unsubscribe", () => {
    const built: MetricsSampler[] = [];
    const cache = createMetricsSamplerCache((udid) => {
      const s = new MetricsSampler({ udid, sample: async () => null, hostCores: 8 });
      built.push(s);
      return s;
    });

    const a = cache.subscribe(UDID, () => {});
    const b = cache.subscribe(UDID, () => {});
    expect(built).toHaveLength(1); // one shared sampler
    expect(a.meta.udid).toBe(UDID);

    a.unsubscribe();
    expect(built[0]!.listenerCount).toBe(1); // still alive for b
    b.unsubscribe();

    // A fresh subscribe after the last leaves builds a new sampler.
    const c = cache.subscribe(UDID, () => {});
    expect(built).toHaveLength(2);
    c.unsubscribe();
  });

  it("fans one sample out to every subscriber", async () => {
    let sampler!: MetricsSampler;
    const cache = createMetricsSamplerCache((udid) => {
      sampler = new MetricsSampler({ udid, sample: async () => ({ bundleId: "dev.expo.A", processKey: "1", cpuSeconds: 5, memBytes: 9, netInBytesPerSec: 0, netOutBytesPerSec: 0 }), now: (() => { let t = 0; return () => (t += 1000); })(), hostCores: 8 });
      return sampler;
    });
    const seen: number[] = [];
    const a = cache.subscribe(UDID, () => seen.push(1));
    const b = cache.subscribe(UDID, () => seen.push(2));
    await sampler.tickOnce();
    expect(seen.sort()).toEqual([1, 2]);
    a.unsubscribe();
    b.unsubscribe();
  });

  it("a stale double-unsubscribe does not evict a replacement sampler", () => {
    const built: MetricsSampler[] = [];
    const cache = createMetricsSamplerCache((udid) => {
      const s = new MetricsSampler({ udid, sample: async () => null, hostCores: 8 });
      built.push(s);
      return s;
    });

    const first = cache.subscribe(UDID, () => {}); // builds sampler #1
    first.unsubscribe(); // last listener -> stops + evicts #1
    const second = cache.subscribe(UDID, () => {}); // builds sampler #2 for the same udid
    expect(built).toHaveLength(2);

    first.unsubscribe(); // stale, replayed: must NOT evict #2

    // #2 is still the active sampler, so a new subscriber reuses it (no #3 built).
    const third = cache.subscribe(UDID, () => {});
    expect(built).toHaveLength(2);

    second.unsubscribe();
    third.unsubscribe();
    expect(second.meta.udid).toBe(UDID);
  });
});
