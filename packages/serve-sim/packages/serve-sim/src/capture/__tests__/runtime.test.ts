import { capabilityHarness } from "./capability-harness";
import { describe, expect, test } from "bun:test";

import { createCaptureRuntime, CaptureEnableError } from "../runtime";
import { CaptureStore } from "../store";
import { type CaptureProxy, type MitmProxyDeps } from "../mitm-engine";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";
const PORT_FILE = "/tmp/fake-confdir/proxy-port";
const CA_PEM = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n";

/** A runtime with every external effect recorded rather than performed. */
function harness(
  overrides: {
    closeProxy?: () => Promise<void>;
    startProxy?: (store: CaptureStore, deps: MitmProxyDeps) => Promise<CaptureProxy>;
    trustCa?: (udid: string, caPem: string) => Promise<void>;
    inject?: (udid: string, portFile: string) => Promise<void>;
    clearInjection?: (udid: string) => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const runtime = createCaptureRuntime({
    startProxy:
      overrides.startProxy ??
      (async () => {
        calls.push("proxy-started");
        return {
          address: "127.0.0.1:9123",
          portFile: "/tmp/fake-confdir/proxy-port",
          caPem: async () => CA_PEM,
          close: overrides.closeProxy ?? (async () => void calls.push("proxy-closed")),
        };
      }),
    trustCa:
      overrides.trustCa ??
      (async (_udid, pem) => void calls.push(`trusted:${pem === CA_PEM ? "ok" : "wrong-pem"}`)),
    dylib: () => "/fake/libSimNetProxy.dylib",
    configure: capabilityHarness({
      publish: overrides.inject ?? (async (_udid, portFile) => void calls.push(`injected:${portFile}`)),
      remove: overrides.clearInjection ?? (async () => void calls.push("injection-cleared")),
    }),
  });
  return { runtime, calls };
}

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("capture runtime", () => {
  test("joins startup instead of resolving another enable with starting metadata", async () => {
    const trust = gate();
    const { runtime, calls } = harness({ trustCa: () => trust.promise });
    const first = runtime.enableForDevice(UDID);
    const second = runtime.enableForDevice(UDID);
    expect(second).toBe(first);
    trust.release();
    expect((await second).attachment).toBe("capturing");
    expect(calls.filter((call) => call === "proxy-started")).toHaveLength(1);
    await runtime.disableAll();
  });

  test("finishes failed startup cleanup before retrying and never clears its successor", async () => {
    const clearing = gate();
    const clear = gate();
    let trusts = 0;
    let clears = 0;
    let armed = false;
    const { runtime, calls } = harness({
      trustCa: async () => { if (++trusts === 1) throw new Error("first trust failed"); },
      closeProxy: async () => {
        if (++clears === 1) {
          clearing.release();
          await clear.promise;
        }
        armed = false;
      },
      inject: async () => { armed = true; },
    });
    const first = runtime.enableForDevice(UDID).catch((error: unknown) => error);
    await clearing.promise;
    const retry = runtime.enableForDevice(UDID);
    clear.release();
    expect(await first).toBeInstanceOf(CaptureEnableError);
    expect((await retry).attachment).toBe("capturing");
    expect(armed).toBe(true);
    expect(clears).toBe(1);
    expect(calls.filter((call) => call === "proxy-started")).toHaveLength(2);
    await runtime.disableAll();
  });

  test("coalesces queued retries and cancels them together on shutdown", async () => {
    const clearing = gate();
    const clear = gate();
    const { runtime, calls } = harness({
      trustCa: async () => { throw new Error("trust failed"); },
      closeProxy: async () => { clearing.release(); await clear.promise; },
    });
    const first = runtime.enableForDevice(UDID).catch((error: unknown) => error);
    await clearing.promise;
    const retry = runtime.enableForDevice(UDID);
    const again = runtime.enableForDevice(UDID);
    expect(again).toBe(retry);
    const result = retry.catch((error: unknown) => error);
    const shutdown = runtime.disableAll();
    clear.release();
    await shutdown;
    expect(await first).toBeInstanceOf(CaptureEnableError);
    expect(await result).toBeInstanceOf(CaptureEnableError);
    expect(calls.filter((call) => call === "proxy-started")).toHaveLength(1);
    expect(runtime.metaFor(UDID).attachment).toBe("not-enabled");
  });

  test("joins a retry cleaning up a failed session and cancels it before another proxy starts", async () => {
    const clearing = gate();
    const clear = gate();
    let killProxy = (_reason: string) => {};
    let starts = 0;
    const { runtime } = harness({
      startProxy: async (_store, deps) => {
        starts++;
        killProxy = deps.onUnexpectedExit ?? (() => {});
        return { address: "127.0.0.1:9123", portFile: PORT_FILE, caPem: async () => CA_PEM, close: async () => {} };
      },
      clearInjection: async () => { clearing.release(); await clear.promise; },
    });
    await runtime.enableForDevice(UDID);
    killProxy("proxy stopped");
    const retry = runtime.enableForDevice(UDID);
    await clearing.promise;
    const again = runtime.enableForDevice(UDID);
    const results = Promise.all([retry, again].map((promise) => promise.catch((error: unknown) => error)));
    const shutdown = runtime.disableAll();
    clear.release();
    await shutdown;
    const outcomes = await results;
    expect(again).toBe(retry);
    expect(outcomes.every((outcome) => outcome instanceof CaptureEnableError)).toBe(true);
    expect(starts).toBe(1);
    expect(runtime.metaFor(UDID).attachment).toBe("not-enabled");
  });

  test("shutdown cancels an enable already queued behind teardown", async () => {
    const clear = gate();
    const { runtime, calls } = harness({ clearInjection: () => clear.promise });
    await runtime.enableForDevice(UDID);
    const stopping = runtime.disableForDevice(UDID);
    const queued = runtime.enableForDevice(UDID).catch((error: unknown) => error);
    const shutdown = runtime.disableAll();
    clear.release();
    await Promise.all([stopping, shutdown]);
    expect(await queued).toBeInstanceOf(CaptureEnableError);
    expect(runtime.metaFor(UDID).attachment).toBe("not-enabled");
    expect(calls.filter((call) => call === "proxy-started")).toHaveLength(1);
    expect((await runtime.enableForDevice(UDID)).attachment).toBe("capturing");
    await runtime.disableAll();
  });

  test("starts the proxy, trusts the CA, then points the device at it", async () => {
    const { runtime, calls } = harness();
    const meta = await runtime.enableForDevice(UDID);

    expect(meta.attachment).toBe("capturing");
    expect(meta.proxyAddress).toBe("127.0.0.1:9123");
    expect(meta.attachError).toBeNull();
    // Order matters: an app launched before the CA is trusted fails every HTTPS handshake.
    expect(calls).toEqual(["proxy-started", "trusted:ok", `injected:${PORT_FILE}`]);
  });

  test("reports a device that was never enabled, rather than inventing a session", () => {
    const { runtime } = harness();
    const meta = runtime.metaFor(UDID);

    expect(meta.attachment).toBe("not-enabled");
    expect(meta.attachError).toBeNull();
    expect(runtime.storeFor(UDID)).toBeNull();
    expect(runtime.throughputFor(UDID)).toBeNull();
  });

  test("enables a device once, however many times it is asked", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    await runtime.enableForDevice(UDID);

    expect(calls.filter((call) => call === "proxy-started")).toHaveLength(1);
  });

  test("reports a trust failure instead of claiming the device is capturing", async () => {
    const { runtime, calls } = harness({
      trustCa: async () => {
        throw new Error("simctl refused");
      },
    });
    const err = await runtime.enableForDevice(UDID).catch((e) => e);

    expect(err).toBeInstanceOf(CaptureEnableError);
    expect(err.meta.attachment).toBe("failed");
    expect(err.meta.attachError).toContain("simctl refused");
    // Nothing was pointed at a proxy the device would refuse.
    expect(calls).not.toContain(`injected:${PORT_FILE}`);
    // Proxy must not keep running after a failed enable, or retries / ports leak.
    expect(calls).toContain("proxy-closed");
  });

  test("retries enable after a prior failure", async () => {
    let failTrust = true;
    const { runtime, calls } = harness({
      trustCa: async () => {
        if (failTrust) throw new Error("simctl refused");
      },
    });
    await expect(runtime.enableForDevice(UDID)).rejects.toBeInstanceOf(CaptureEnableError);
    expect(runtime.metaFor(UDID).attachment).toBe("failed");

    failTrust = false;
    calls.length = 0;
    const meta = await runtime.enableForDevice(UDID);

    expect(meta.attachment).toBe("capturing");
    expect(calls).toContain("proxy-started");
    expect(calls).toContain(`injected:${PORT_FILE}`);
  });

  test("rejects when the proxy never starts, after publishing failed meta", async () => {
    const { runtime } = harness({
      startProxy: async () => {
        throw new Error("mitmproxy is not installed");
      },
    });
    const err = await runtime.enableForDevice(UDID).catch((e) => e);

    expect(err).toBeInstanceOf(CaptureEnableError);
    expect(err.meta.attachment).toBe("failed");
    expect(err.meta.attachError).toContain("mitmproxy is not installed");
    expect(err.meta.proxyAddress).toBeNull();
  });

  test("reports an injection failure with the reason", async () => {
    const { runtime, calls } = harness({
      inject: async () => {
        throw new Error("dist/simnet is missing");
      },
    });
    const err = await runtime.enableForDevice(UDID).catch((e) => e);

    expect(err).toBeInstanceOf(CaptureEnableError);
    expect(err.meta.attachment).toBe("failed");
    expect(err.meta.attachError).toContain("dist/simnet is missing");
    expect(calls).toContain("proxy-closed");
  });

  test("publishes meta when enable finishes so SSE clients leave starting", async () => {
    const { runtime } = harness();
    const seen: string[] = [];
    const pending = runtime.enableForDevice(UDID);
    const { meta, unsubscribe } = runtime.subscribe(UDID, (event) => {
      if (event.type === "meta") seen.push(event.meta.attachment);
    });
    expect(meta.attachment).toBe("starting");
    await pending;
    unsubscribe();
    expect(seen).toContain("capturing");
  });

  test("clears the injection before closing the proxy", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    calls.length = 0;

    await runtime.disableForDevice(UDID);

    expect(calls).toEqual(["injection-cleared", "proxy-closed"]);
    expect(runtime.storeFor(UDID)).toBeNull();
  });

  test("keeps the proxy reachable when capability removal fails", async () => {
    const { runtime, calls } = harness({
      clearInjection: async () => {
        throw new Error("device already shut down");
      },
    });
    await runtime.enableForDevice(UDID);

    await expect(runtime.disableForDevice(UDID)).rejects.toThrow("device already shut down");
    expect(calls).not.toContain("proxy-closed");
    expect(runtime.storeFor(UDID)).not.toBeNull();
  });

  test("waits for a teardown in flight before it arms the device again", async () => {
    let releaseClear: () => void = () => {};
    const pending = new Promise<void>((done) => {
      releaseClear = done;
    });
    let clears = 0;
    const { runtime, calls } = harness({
      clearInjection: async () => {
        clears += 1;
        if (clears === 1) await pending;
        calls.push("injection-cleared");
      },
    });
    await runtime.enableForDevice(UDID);

    const stopping = runtime.disableForDevice(UDID);
    const starting = runtime.enableForDevice(UDID);
    await Bun.sleep(10);
    releaseClear();
    await Promise.all([stopping, starting]);

    expect(calls.indexOf("injection-cleared")).toBeLessThan(calls.lastIndexOf(`injected:${PORT_FILE}`));
    expect(runtime.metaFor(UDID).attachment).toBe("capturing");

    // And the session that survived is the one shutdown has to find.
    await runtime.disableAll();
    expect(runtime.metaFor(UDID).attachment).toBe("not-enabled");
    expect(calls.filter((call) => call === "proxy-closed")).toHaveLength(2);
  });

  test("makes a second shutdown wait for the first, not walk past it", async () => {
    // Both callers exit the process when they return.
    let releaseClear: () => void = () => {};
    const pending = new Promise<void>((done) => {
      releaseClear = done;
    });
    const { runtime, calls } = harness({
      clearInjection: async () => {
        calls.push("clearing");
        await pending;
        calls.push("injection-cleared");
      },
    });
    await runtime.enableForDevice(UDID);

    const first = runtime.disableAll();
    const second = runtime.disableAll();
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    await Bun.sleep(10);
    expect(secondDone).toBe(false);

    releaseClear();
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
  });

  test("stops every device on shutdown", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    await runtime.enableForDevice("SECOND-DEVICE");
    calls.length = 0;

    await runtime.disableAll();

    expect(calls.filter((call) => call === "proxy-closed")).toHaveLength(2);
    expect(runtime.storeFor(UDID)).toBeNull();
    expect(runtime.storeFor("SECOND-DEVICE")).toBeNull();
  });

  test("reports a proxy that dies mid-session, and says the apps need relaunching", async () => {
    let killProxy: (reason: string) => void = () => {};
    const frames: string[] = [];
    const { runtime } = harness({
      startProxy: async (_store, deps) => {
        killProxy = deps.onUnexpectedExit ?? (() => {});
        return { address: "127.0.0.1:9123", portFile: "/tmp/fake-confdir/proxy-port", caPem: async () => CA_PEM, close: async () => {} };
      },
    });
    await runtime.enableForDevice(UDID);
    runtime.subscribe(UDID, (event) => frames.push(event.type));

    killProxy("The capture proxy stopped unexpectedly (exit 1).");

    const meta = runtime.metaFor(UDID);
    expect(meta.attachment).toBe("failed");
    expect(meta.attachError).toContain("stopped unexpectedly");
    expect(meta.attachError?.toLowerCase()).toContain("relaunch");
    // Every viewer is told, rather than only the next one to subscribe.
    expect(frames).toContain("meta");
  });

  test("does not report capturing when the proxy died while capture was starting", async () => {
    let killProxy: (reason: string) => void = () => {};
    const { runtime, calls } = harness({
      startProxy: async (_store, deps) => {
        killProxy = deps.onUnexpectedExit ?? (() => {});
        return {
          address: "127.0.0.1:9123",
          portFile: PORT_FILE,
          caPem: async () => CA_PEM,
          close: async () => void calls.push("proxy-closed"),
        };
      },
      trustCa: async () => {
        killProxy("The capture proxy stopped unexpectedly (exit 1).");
      },
    });

    await expect(runtime.enableForDevice(UDID)).rejects.toBeInstanceOf(CaptureEnableError);

    const meta = runtime.metaFor(UDID);
    expect(meta.attachment).toBe("failed");
    expect(meta.attachError).toContain("stopped unexpectedly");
    expect(calls).toContain("proxy-closed");
  });

  test("stops a device that was disabled while its capture was starting", async () => {
    let releaseProxy: () => void = () => {};
    const pending = new Promise<void>((done) => {
      releaseProxy = done;
    });
    const { runtime, calls } = harness({
      startProxy: async () => {
        calls.push("proxy-started");
        await pending;
        return {
          address: "127.0.0.1:9123",
          portFile: PORT_FILE,
          caPem: async () => CA_PEM,
          close: async () => void calls.push("proxy-closed"),
        };
      },
    });

    const enabling = runtime.enableForDevice(UDID);
    const stopping = runtime.disableForDevice(UDID);
    releaseProxy();

    await expect(enabling).rejects.toBeInstanceOf(CaptureEnableError);
    await stopping;
    // The device must not be left armed, and the proxy nobody can reach must not be left running.
    expect(calls).not.toContain(`injected:${PORT_FILE}`);
    expect(calls).toContain("proxy-closed");
    expect(runtime.metaFor(UDID).attachment).toBe("not-enabled");
  });

  test("counts oversized control bodies onto meta for the UI and logs", async () => {
    let reportOversized: NonNullable<MitmProxyDeps["onOversizedControlBody"]> = () => {};
    const frames: Array<{ type: string; meta?: { droppedOversizedBodies?: number } }> = [];
    const { runtime } = harness({
      startProxy: async (_store, deps) => {
        reportOversized = deps.onOversizedControlBody ?? (() => {});
        return {
          address: "127.0.0.1:9123",
          portFile: "/tmp/fake-confdir/proxy-port",
          caPem: async () => CA_PEM,
          close: async () => {},
        };
      },
    });
    await runtime.enableForDevice(UDID);
    runtime.subscribe(UDID, (event) => {
      if (event.type === "meta") frames.push(event);
    });

    reportOversized({ bytesSeen: 11_000_000, limit: 10_485_760, path: "/response" });
    reportOversized({ bytesSeen: 12_000_000, limit: 10_485_760, path: "/response" });

    expect(runtime.metaFor(UDID).droppedOversizedBodies).toBe(2);
    expect(frames.at(-1)?.meta?.droppedOversizedBodies).toBe(2);
  });

  test("reports proxy throughput only while the device is capturing", async () => {
    const failed = harness({
      trustCa: async () => {
        throw new Error("nope");
      },
    });
    await expect(failed.runtime.enableForDevice(UDID)).rejects.toBeInstanceOf(CaptureEnableError);
    expect(failed.runtime.throughputFor(UDID)).toBeNull();

    const capturing = harness();
    await capturing.runtime.enableForDevice(UDID);
    capturing.runtime.storeFor(UDID)!.noteTraffic(1500, 200);
    expect(capturing.runtime.throughputFor(UDID)).toEqual({ netInBytesPerSec: 1500, netOutBytesPerSec: 200 });
  });

  test("reads as starting, not as failed, while it is still coming up", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime } = harness({
      startProxy: async () => {
        await gate;
        return { address: "127.0.0.1:9123", portFile: "/tmp/fake-confdir/proxy-port", caPem: async () => CA_PEM, close: async () => {} };
      },
    });

    const pending = runtime.enableForDevice(UDID);
    // A viewer subscribing mid-reboot must not be told capture failed, with no reason to show.
    expect(runtime.metaFor(UDID).attachment).toBe("starting");
    expect(runtime.metaFor(UDID).attachError).toBeNull();

    release();
    expect((await pending).attachment).toBe("capturing");
  });


  test("hands a subscriber the live store without changing what the device does", async () => {
    const { runtime, calls } = harness();
    await runtime.enableForDevice(UDID);
    calls.length = 0;

    const events: string[] = [];
    const first = runtime.subscribe(UDID, (event) => events.push(event.type));
    const second = runtime.subscribe(UDID, () => {});
    runtime.storeFor(UDID)!.start("GET", "https://example.test/a");
    first.unsubscribe();
    second.unsubscribe();

    expect(events).toEqual(["started"]);
    // Subscribing and leaving is not a lifecycle event.
    expect(calls).toEqual([]);
    expect(runtime.metaFor(UDID).attachment).toBe("capturing");
  });

});
