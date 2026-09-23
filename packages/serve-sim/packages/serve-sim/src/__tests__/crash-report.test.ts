import { describe, expect, test } from "bun:test";
import { isSimulatorAppCrash, parseCrashReport, parseIpsHeader } from "../crash/report";

const UDID = "CD26E7DF-F2CE-4DCB-B950-2F062DE3FBB3";
const BUNDLE_ROOT =
  `/Users/USER/Library/Developer/CoreSimulator/Devices/${UDID}` +
  "/data/Containers/Bundle/Application/9E92F5F8/Demo.app";

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app_name: "Demo",
    timestamp: "2026-08-03 22:53:09.00 -0700",
    app_version: "1.0.0",
    build_version: "1",
    platform: 7,
    bundleID: "com.example.demo",
    bug_type: "309",
    os_version: "macOS 26.5.1 (25F80)",
    incident_id: "9DE028DC-1A17-4AEF-943E-E9F6D0F7883B",
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    procName: "Demo",
    procPath: `${BUNDLE_ROOT}/Demo`,
    pid: 58278,
    captureTime: "2026-08-03 22:53:09.2219 -0700",
    exception: { type: "EXC_CRASH", signal: "SIGABRT", codes: "0x0, 0x0" },
    termination: {
      indicator: "Abort trap: 6",
      byProc: "Demo",
      byPid: 58278,
      code: 6,
      namespace: "SIGNAL",
    },
    faultingThread: 0,
    legacyInfo: { threadTriggered: { queue: "com.apple.main-thread" } },
    usedImages: [
      { name: "libsystem_kernel.dylib", path: "/usr/lib/system/libsystem_kernel.dylib" },
      { name: "libsystem_c.dylib", path: "/usr/lib/system/libsystem_c.dylib" },
      { name: "Demo", path: `${BUNDLE_ROOT}/Demo` },
    ],
    threads: [
      {
        triggered: true,
        frames: [
          { imageIndex: 0, imageOffset: 34956, symbol: "__pthread_kill" },
          { imageIndex: 1, imageOffset: 473228, symbol: "abort" },
          { imageIndex: 2, imageOffset: 1234, symbol: "specialized AppDelegate.boot()" },
        ],
      },
    ],
    ...overrides,
  };
}

function ips(
  headerOverrides: Record<string, unknown> = {},
  bodyOverrides: Record<string, unknown> = {}
): string {
  return `${JSON.stringify(header(headerOverrides))}\n${JSON.stringify(body(bodyOverrides))}\n`;
}

describe("parseIpsHeader", () => {
  test("reads the single-line JSON header", () => {
    const parsed = parseIpsHeader(ips());
    expect(parsed?.bundleId).toBe("com.example.demo");
    expect(parsed?.platform).toBe(7);
    expect(parsed?.incidentId).toBe("9DE028DC-1A17-4AEF-943E-E9F6D0F7883B");
  });

  test("returns null for a malformed header", () => {
    expect(parseIpsHeader("not json\n{}")).toBeNull();
    expect(parseIpsHeader("")).toBeNull();
    expect(parseIpsHeader("[1,2,3]\n{}")).toBeNull();
  });
});

describe("isSimulatorAppCrash", () => {
  test("accepts a simulator crash", () => {
    expect(isSimulatorAppCrash(parseIpsHeader(ips()))).toBe(true);
  });

  test("rejects a non-simulator platform", () => {
    expect(isSimulatorAppCrash(parseIpsHeader(ips({ platform: 2 })))).toBe(false);
  });

  test("rejects a non-crash bug type", () => {
    expect(isSimulatorAppCrash(parseIpsHeader(ips({ bug_type: "288" })))).toBe(false);
  });

  test("rejects a header with no bundle id", () => {
    expect(isSimulatorAppCrash(parseIpsHeader(ips({ bundleID: undefined })))).toBe(false);
  });

  test("rejects a header whose platform is not a number", () => {
    expect(isSimulatorAppCrash(parseIpsHeader(ips({ platform: "7" })))).toBe(false);
  });
});

describe("parseCrashReport", () => {
  test("projects the fields an agent needs", () => {
    const report = parseCrashReport(ips());
    expect(report).not.toBeNull();
    expect(report?.bundleId).toBe("com.example.demo");
    expect(report?.appName).toBe("Demo");
    expect(report?.appVersion).toBe("1.0.0");
    expect(report?.buildVersion).toBe("1");
    expect(report?.pid).toBe(58278);
    expect(report?.exceptionType).toBe("EXC_CRASH");
    expect(report?.signal).toBe("SIGABRT");
    expect(report?.terminationIndicator).toBe("Abort trap: 6");
    expect(report?.faultingQueue).toBe("com.apple.main-thread");
    expect(report?.incidentId).toBe("9DE028DC-1A17-4AEF-943E-E9F6D0F7883B");
  });

  test("parses the crash time to epoch ms so a consumer never parses Apple's format", () => {
    const report = parseCrashReport(ips());
    expect(report?.capturedAt).toBe("2026-08-03 22:53:09.2219 -0700");
    expect(report?.capturedAtMs).toBe(Date.parse("2026-08-03 22:53:09.2219 -0700"));
  });

  test("leaves the epoch time null when the crash time will not parse", () => {
    const report = parseCrashReport(ips({}, { captureTime: "not a date" }));
    expect(report?.capturedAtMs).toBeNull();
  });

  test("reads the device udid out of the container path", () => {
    expect(parseCrashReport(ips())?.deviceUdid).toBe(UDID);
  });

  test("leaves the device udid null for a path outside a simulator container", () => {
    const report = parseCrashReport(ips({}, { procPath: "/Applications/Demo.app/Demo" }));
    expect(report?.deviceUdid).toBeNull();
  });

  test("picks the first app-owned frame as the culprit", () => {
    const report = parseCrashReport(ips());
    expect(report?.culpritFrame).toBe("Demo specialized AppDelegate.boot()");
  });

  test("marks which frames belong to the app bundle", () => {
    const report = parseCrashReport(ips());
    expect(report?.frames.map((frame) => frame.appOwned)).toEqual([false, false, true]);
  });

  test("treats bundled frameworks as app-owned", () => {
    const report = parseCrashReport(
      ips(
        {},
        {
          usedImages: [
            { name: "libsystem_c.dylib", path: "/usr/lib/system/libsystem_c.dylib" },
            {
              name: "hermes",
              path: `${BUNDLE_ROOT}/Frameworks/hermes.framework/hermes`,
            },
          ],
          threads: [
            {
              triggered: true,
              frames: [
                { imageIndex: 0, imageOffset: 1, symbol: "abort" },
                { imageIndex: 1, imageOffset: 2, symbol: "facebook::hermes::badBytecode()" },
              ],
            },
          ],
        }
      )
    );
    expect(report?.culpritFrame).toBe("hermes facebook::hermes::badBytecode()");
  });

  test("falls back to the top frame when no app image appears", () => {
    const report = parseCrashReport(
      ips(
        {},
        {
          usedImages: [
            { name: "libsystem_kernel.dylib", path: "/usr/lib/system/libsystem_kernel.dylib" },
          ],
          threads: [
            { triggered: true, frames: [{ imageIndex: 0, imageOffset: 5, symbol: "__kill" }] },
          ],
        }
      )
    );
    expect(report?.culpritFrame).toBe("libsystem_kernel.dylib __kill");
  });

  test("reads the faulting thread by index, not by the triggered flag", () => {
    const report = parseCrashReport(
      ips(
        {},
        {
          faultingThread: 1,
          threads: [
            {
              triggered: true,
              frames: [{ imageIndex: 2, imageOffset: 1, symbol: "idleThread" }],
            },
            {
              frames: [{ imageIndex: 2, imageOffset: 9, symbol: "AppDelegate.crash()" }],
            },
          ],
        }
      )
    );
    expect(report?.culpritFrame).toBe("Demo AppDelegate.crash()");
  });

  test("falls back to the triggered thread when the index is unusable", () => {
    for (const faultingThread of [null, "0", undefined, 99]) {
      const report = parseCrashReport(
        ips(
          {},
          {
            faultingThread,
            threads: [
              { frames: [{ imageIndex: 2, imageOffset: 1, symbol: "idleThread" }] },
              {
                triggered: true,
                frames: [{ imageIndex: 2, imageOffset: 9, symbol: "AppDelegate.crash()" }],
              },
            ],
          }
        )
      );
      expect(report?.culpritFrame).toBe("Demo AppDelegate.crash()");
    }
  });

  test("still caps the stack when the app frame is within it", () => {
    const report = parseCrashReport(
      ips(
        {},
        {
          threads: [
            {
              triggered: true,
              frames: [
                { imageIndex: 2, imageOffset: 1, symbol: "App.early()" },
                ...Array.from({ length: 40 }, (_unused, index) => ({
                  imageIndex: 0,
                  imageOffset: index,
                  symbol: `sysFrame${index}`,
                })),
              ],
            },
          ],
        }
      )
    );
    expect(report?.frames).toHaveLength(24);
  });

  test("picks the culprit from the whole stack, past the frame cap", () => {
    const deepStack = (appSymbol: string): string =>
      ips(
        {},
        {
          usedImages: [
            { name: "libsystem_kernel.dylib", path: "/usr/lib/system/libsystem_kernel.dylib" },
            { name: "Demo", path: `${BUNDLE_ROOT}/Demo` },
          ],
          threads: [
            {
              triggered: true,
              frames: [
                ...Array.from({ length: 30 }, (_unused, index) => ({
                  imageIndex: 0,
                  imageOffset: index,
                  symbol: `sysFrame${index}`,
                })),
                { imageIndex: 1, imageOffset: 999, symbol: appSymbol },
              ],
            },
          ],
        }
      );

    const first = parseCrashReport(deepStack("App.alpha()"));
    expect(first?.culpritFrame).toBe("Demo App.alpha()");
    expect(first?.frames).toHaveLength(31);
    expect(first?.frames.at(-1)).toMatchObject({ symbol: "App.alpha()", appOwned: true });
    // Two crashes that differ only past the cap must not share a signature.
    expect(first?.signature).not.toBe(parseCrashReport(deepStack("App.beta()"))?.signature);
  });

  test("ignores header fields that are not strings", () => {
    const report = parseCrashReport(
      ips({ incident_id: 123, app_version: { major: 1 }, timestamp: {} })
    );
    expect(report?.incidentId).toBeNull();
    expect(report?.appVersion).toBeNull();
    expect(report?.capturedAt).toBe("2026-08-03 22:53:09.2219 -0700");
  });

  test("keeps a frame whose image index is out of range", () => {
    const report = parseCrashReport(
      ips({}, { threads: [{ triggered: true, frames: [{ imageIndex: 99, imageOffset: 1 }] }] })
    );
    expect(report?.culpritFrame).toBe("unknown +1");
  });

  test("describes an unsymbolized frame by image offset", () => {
    const report = parseCrashReport(
      ips(
        {},
        {
          threads: [
            { triggered: true, frames: [{ imageIndex: 2, imageOffset: 4242 }] },
          ],
        }
      )
    );
    expect(report?.culpritFrame).toBe("Demo +4242");
  });

  test("gives the same signature across occurrences with a different pid and time", () => {
    const first = parseCrashReport(ips({ incident_id: "INC-1" }, { pid: 1 }));
    const second = parseCrashReport(
      ips({ incident_id: "INC-2" }, { pid: 2, captureTime: "2026-08-04 01:00:00.0000 -0700" })
    );
    expect(first!.signature).toBe(second!.signature);
  });

  test("gives a different signature when the culprit frame differs", () => {
    const first = parseCrashReport(ips());
    const second = parseCrashReport(
      ips(
        {},
        {
          threads: [
            {
              triggered: true,
              frames: [{ imageIndex: 2, imageOffset: 77, symbol: "SomethingElse.boom()" }],
            },
          ],
        }
      )
    );
    expect(first?.signature).not.toBe(second?.signature);
  });

  test("separates two unsymbolized crashes at different offsets in one binary", () => {
    const at = (imageOffset: number) =>
      parseCrashReport(
        ips(
          {},
          {
            usedImages: [{ name: "Demo", path: `${BUNDLE_ROOT}/Demo`, uuid: "UUID-1" }],
            threads: [{ triggered: true, frames: [{ imageIndex: 0, imageOffset }] }],
          }
        )
      );

    expect(at(100)?.signature).not.toBe(at(200)?.signature);
    expect(at(100)?.signature).toBe(at(100)?.signature);
  });

  test("returns null for a body that is not a crash report", () => {
    expect(parseCrashReport(`${JSON.stringify(header())}\nnot json`)).toBeNull();
    expect(parseCrashReport(JSON.stringify(header()))).toBeNull();
  });

  test("survives a report with no threads or images", () => {
    const report = parseCrashReport(ips({}, { threads: undefined, usedImages: undefined }));
    expect(report?.bundleId).toBe("com.example.demo");
    expect(report?.culpritFrame).toBeNull();
    expect(report?.frames).toEqual([]);
  });
});
