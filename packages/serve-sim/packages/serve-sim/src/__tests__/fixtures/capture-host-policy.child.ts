import { expect, test } from "bun:test";

import { captureRuntime } from "../../capture";
import { simMiddleware } from "../../middleware";

const UDID = "ABCD1234-0000-0000-0000-0000000000EF";

async function enableError(): Promise<string> {
  const error = await captureRuntime.enableForDevice(UDID).then(() => "", (e: unknown) => String((e as { meta?: { attachError?: string } }).meta?.attachError ?? e));
  await captureRuntime.disableForDevice(UDID).catch(() => {});
  return error;
}

const REFUSAL = "Network capture needs a token-gated preview";

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
