import { expect, test } from "bun:test";
import { readFile, rm } from "fs/promises";

import { runHostActionAsync } from "../host-actions";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { EXIT_0_SHIM, withShimsAsync } from "./helpers";

const udid = e2eDevice();
requireE2E("host screenshot", Boolean(udid));

for (const display of [undefined, 1]) {
  test.skipIf(!udid)(
    `screenshot.capture returns a PNG for ${display === undefined ? "the active display" : "numeric display 1"}`,
    async () => {
      // Exercise real simctl and native panel selection without writing to the Desktop.
      await withShimsAsync({ cp: EXIT_0_SHIM }, async () => {
        const result = await runHostActionAsync(
          { action: "screenshot.capture", params: { udid: udid!, display } },
          process.execPath,
        );
        const path = result.stdout.trim();
        try {
          expect(result.exitCode, result.stderr).toBe(0);
          const png = await readFile(path);
          expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
          expect(png.toString("ascii", 12, 16)).toBe("IHDR");
          expect(png.readUInt32BE(16)).toBeGreaterThan(0);
          expect(png.readUInt32BE(20)).toBeGreaterThan(0);
        } finally {
          if (path) await rm(path, { force: true });
        }
      });
    },
    45_000,
  );
}
