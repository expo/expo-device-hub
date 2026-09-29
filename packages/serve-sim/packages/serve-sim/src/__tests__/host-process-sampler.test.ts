import { describe, expect, test } from "bun:test";

import { HostProcessSampler, parseIoregGpu, parsePsRows } from "../host-process-sampler";

const ioreg = (deviceHubNs: number, nodeNs: number) => `
  | |   "PerformanceStatistics" = {"Device Utilization %"=12,"Renderer Utilization %"=9}
  | | +-o AGXDeviceUserClient
  | |     "IOUserClientCreator" = "pid 501, DeviceHub"
  | |     "AppUsage" = ({"accumulatedGPUTime"=${deviceHubNs},"API"="Metal"})
  | | +-o AGXDeviceUserClient
  | |     "IOUserClientCreator" = "pid 900, node"
  | |     "AppUsage" = ({"accumulatedGPUTime"=${nodeNs}},{"accumulatedGPUTime"=0})
`;

const ps = (deviceHubCpu: string, nodeCpu: string) =>
  [
    `  501 ${deviceHubCpu} 204800 /Applications/Xcode.app/Contents/Developer/Applications/DeviceHub.app/Contents/MacOS/DeviceHub`,
    `  900 ${nodeCpu} 102400 /usr/local/bin/node`,
    `    1 0:01.00 8192 /sbin/launchd`,
  ].join("\n");

describe("host process sampler", () => {
  test("parses ps rows with the executable name", () => {
    expect(parsePsRows(ps("1:02.50", "0:10.00"))).toEqual([
      { pid: 501, name: "DeviceHub", cpuSeconds: 62.5, rssKb: 204800 },
      { pid: 900, name: "node", cpuSeconds: 10, rssKb: 102400 },
      { pid: 1, name: "launchd", cpuSeconds: 1, rssKb: 8192 },
    ]);
  });

  test("sums GPU time per client pid", () => {
    const gpu = parseIoregGpu(ioreg(5_000_000, 7_000_000));
    expect(gpu.deviceUtilizationPct).toBe(12);
    expect(gpu.rendererUtilizationPct).toBe(9);
    expect([...gpu.clients]).toEqual([
      [501, { name: "DeviceHub", gpuNs: 5_000_000 }],
      [900, { name: "node", gpuNs: 7_000_000 }],
    ]);
  });

  test("reports CPU and GPU used over the interval, and the host apps", async () => {
    const readings = [
      { ps: ps("0:10.00", "0:20.00"), ioreg: ioreg(1_000_000_000, 0) },
      { ps: ps("0:10.50", "0:22.00"), ioreg: ioreg(1_050_000_000, 20_000_000) },
    ];
    let reading = 0;
    let now = 0;
    const sampler = new HostProcessSampler({
      now: () => now,
      exec: async (file) => (file === "ps" ? readings[reading]!.ps : readings[reading]!.ioreg),
    });

    expect(await sampler.tickOnce()).toBeNull();
    reading = 1;
    now = 5000;
    const sample = await sampler.tickOnce();

    expect(sample?.kind).toBe("host");
    expect(sample?.intervalMs).toBe(5000);
    expect(sample?.hostApps).toEqual([{ name: "DeviceHub", pid: 501, cpuPct: 10, gpuMs: 50 }]);
    expect(sample?.top.map((p) => [p.name, p.cpuPct])).toEqual([
      ["node", 40],
      ["DeviceHub", 10],
      ["launchd", 0],
    ]);
    expect(sample?.gpu.clients).toEqual([
      { pid: 501, name: "DeviceHub", gpuMs: 50 },
      { pid: 900, name: "node", gpuMs: 20 },
    ]);
  });
});
