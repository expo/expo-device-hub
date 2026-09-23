import { describe, expect, test } from "bun:test";

import { launchAppAsync } from "../launch-app";

describe("launchAppAsync", () => {
  // A relaunch has to stop the app first, and simctl launch is a no-op on an app
  // that is already running. Not knowing whether it stopped has to be an error,
  // or the launch reports success while the old process keeps running.
  test("refuses to relaunch when it cannot tell whether the app stopped", async () => {
    await expect(
      launchAppAsync("NOT-A-DEVICE", { bundleId: "host.exp.Exponent", launchArgs: [] }),
    ).rejects.toThrow("could not check whether it is still running");
  });

  test("names the device it could not reach", async () => {
    await expect(
      launchAppAsync("NOT-A-DEVICE", { bundleId: "host.exp.Exponent", launchArgs: [] }),
    ).rejects.toThrow("NOT-A-DEVICE");
  });
});
