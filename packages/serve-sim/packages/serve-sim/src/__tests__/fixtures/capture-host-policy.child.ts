import { expect, mock, test } from "bun:test";

import * as capture from "../../capture";
import { capabilityHarness } from "../../capture/__tests__/capability-harness";

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
