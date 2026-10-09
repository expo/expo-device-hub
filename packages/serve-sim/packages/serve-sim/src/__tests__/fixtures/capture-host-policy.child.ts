import { expect, spyOn, test } from "bun:test";

import { captureRuntime, createCaptureRuntime } from "../../capture";
import { capabilityHarness } from "../../capture/__tests__/capability-harness";
import type { CaptureUpstream } from "../../capture/upstream";
import { simMiddleware } from "../../middleware";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";

async function enableError(): Promise<string> {
  const error = await captureRuntime.enableForDevice(UDID).then(() => "", (e: unknown) => String((e as { meta?: { attachError?: string } }).meta?.attachError ?? e));
  await captureRuntime.disableForDevice(UDID).catch(() => {});
  return error;
}

const REFUSAL = "Network capture needs a token-gated preview";

test("recreating middleware without an upstream restores direct egress for new captures", async () => {
  const upstreams: (CaptureUpstream | null | undefined)[] = [];
  const runtime = createCaptureRuntime({
    startProxy: async (_store, deps) => {
      upstreams.push(deps.upstream);
      return {
        address: "127.0.0.1:9999", portFile: "/tmp/fake-proxy-port",
        caPem: async () => "test-ca", close: async () => {},
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
  simMiddleware({ basePath: "/" });
  expect(await enableError()).toContain(REFUSAL);
});

test("a loopback-only host or the token gate allows capture past the refusal", async () => {
  simMiddleware({ basePath: "/", loopbackOnly: true });
  expect(await enableError()).not.toContain(REFUSAL);
  simMiddleware({ basePath: "/", requirePreviewToken: true });
  expect(await enableError()).not.toContain(REFUSAL);
  // Past the refusal each attempt really starts capture; with a simulator available that is slow.
}, 30_000);
