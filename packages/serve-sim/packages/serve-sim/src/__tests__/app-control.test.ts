import { expect, test } from "bun:test";
import { homedir } from "os";
import { runHostActionAsync } from "../host-actions";
import { UDID, withShimsAsync } from "./helpers";

const act = (action: string, params: Record<string, unknown> = {}) =>
  runHostActionAsync({ action, params: { udid: UDID, bundleId: "com.example.seed", ...params } }, "serve-sim");

test("deep-link failures are reported with redacted host paths", async () => {
  await withShimsAsync({ xcrun: `#!/bin/sh\nprintf '%s' '${homedir()}/private-link failed' >&2\nexit 1\n` }, async () => {
    const result = await act("app.openUrl", { url: "seed-fixture://setup" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("failed");
    expect(result.stderr).not.toContain(homedir());
  });
});

test("app controls reject device aliases and invalid URLs before executing", async () => {
  for (const action of ["app.stop", "app.openUrl"]) {
    await expect(act(action, { udid: "booted", url: "seed://setup" })).rejects.toThrow();
  }
  for (const url of ["invalid", "seed://setup\0", "seed://" + "a".repeat(8192)]) {
    await expect(act("app.openUrl", { url })).rejects.toThrow();
  }
});
