import { expect, mock, spyOn, test } from "bun:test";

import * as capture from "../../capture";
import { capabilityHarness } from "../../capture/__tests__/capability-harness";
import type { CaptureUpstream } from "../../capture/upstream";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";
const PROXY_START = "host-policy fixture reached proxy start";
let proxyStarts = 0;

// Keep the real runtime's refusal check, but stop allowed starts at a controlled dependency.
const captureRuntime = capture.createCaptureRuntime({
  startProxy: async () => {
    proxyStarts++;
    throw new Error(PROXY_START);
  },
  configure: capabilityHarness(),
  dylib: () => "/fixture/libSimNetProxy.dylib",
  writeDiskArtifacts: false,
});
// This child process confines the singleton replacement to the host-policy fixture.
mock.module("../../capture", () => ({ ...capture, captureRuntime }));
const { simMiddleware } = await import("../../middleware");

async function enableError(): Promise<string> {
  const error = await captureRuntime.enableForDevice(UDID).then(() => "", (e: unknown) => String((e as { meta?: { attachError?: string } }).meta?.attachError ?? e));
  await captureRuntime.disableForDevice(UDID);
  return error;
}

const REFUSAL = "Network capture needs a token-gated preview";

test("recreating middleware without an upstream restores direct egress for new captures", async () => {
  const upstreams: (CaptureUpstream | null | undefined)[] = [];
  const runtime = capture.createCaptureRuntime({
    startProxy: async (_store, deps) => {
      upstreams.push(deps.upstream);
      return {
        address: "127.0.0.1:9999", portFile: "/tmp/fake-proxy-port",
        caPem: async () => "test-ca", setFields: () => {}, close: async () => {},
      };
    },
    trustCa: async () => {},
    dylib: () => "/fake/libSimNetProxy.dylib",
    configure: capabilityHarness(),
    writeDiskArtifacts: false,
    isInjected: async () => true,
  });
  // Keep the middleware's real configuration path; replace only the device-facing runtime.
  const setUpstream = spyOn(captureRuntime, "setUpstream").mockImplementation(runtime.setUpstream);
  try {
    for (const networkCaptureProxy of ["http://user:password@proxy.invalid:8899", undefined, "http://proxy.invalid:8899", "none"]) {
      simMiddleware({ basePath: "/", loopbackOnly: true, networkCaptureProxy });
      await runtime.enableForDevice(UDID);
      await runtime.disableForDevice(UDID);
    }
    expect(upstreams).toEqual([
      { url: "http://proxy.invalid:8899/", auth: "user:password" },
      null,
      { url: "http://proxy.invalid:8899/" },
      null,
    ]);
    simMiddleware({ basePath: "/", loopbackOnly: true, networkCaptureProxy: "http://proxy.invalid:8899" });
    await runtime.enableForDevice(UDID);
    simMiddleware({ basePath: "/", loopbackOnly: true });
    await runtime.enableForDevice(UDID);
    expect(upstreams).toHaveLength(5); // Reusing an active session preserves its upstream.
    await runtime.enableForDevice("ABCD1234-0000-0000-0000-0000000000EE");
    expect(upstreams.at(-1)).toBeNull();
  } finally {
    await runtime.disableAll();
    setUpstream.mockRestore();
  }
});

test("an embedder that does not say it binds to loopback gets capture refused", async () => {
  const startsBefore = proxyStarts;
  simMiddleware({ basePath: "/" });
  expect(await enableError()).toContain(REFUSAL);
  expect(proxyStarts).toBe(startsBefore);
});

test("a loopback-only host allows capture to reach the proxy", async () => {
  const startsBefore = proxyStarts;
  simMiddleware({ basePath: "/", loopbackOnly: true });
  expect(await enableError()).toBe(PROXY_START);
  expect(proxyStarts).toBe(startsBefore + 1);
});

test("the token gate allows capture to reach the proxy", async () => {
  const startsBefore = proxyStarts;
  simMiddleware({ basePath: "/", requirePreviewToken: true });
  expect(await enableError()).toBe(PROXY_START);
  expect(proxyStarts).toBe(startsBefore + 1);
});
