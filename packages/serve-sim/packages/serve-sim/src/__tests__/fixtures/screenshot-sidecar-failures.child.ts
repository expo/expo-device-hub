import { expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const real = { ...fs };
let failure: "write" | "sidecar-rename" | "png-rename";
const full = Object.assign(new Error("sidecar disk full"), { code: "ENOSPC" });
mock.module("node:fs/promises", () => ({
  ...real,
  writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    await real.writeFile(...args);
    if (failure === "write" && String(args[0]).endsWith(".png.json.tmp")) throw full;
  },
  rename: async (...args: Parameters<typeof fs.rename>) => {
    const source = String(args[0]);
    if (
      (failure === "sidecar-rename" && source.endsWith(".png.json.tmp")) ||
      (failure === "png-rename" && source.endsWith(".png.tmp"))
    )
      throw full;
    await real.rename(...args);
  },
}));
const { saveScreenshotArtifact } = await import("../../screenshot-artifacts");

test.each(["write", "sidecar-rename", "png-rename"] as const)(
  "cleans up after %s fails and preserves a failure record",
  async (stage) => {
    failure = stage;
    const directory = await real.mkdtemp(join(tmpdir(), "sidecar-failure-"));
    const previous = process.env.EXPO_DEVICE_HUB_SCREENSHOT_METADATA;
    process.env.EXPO_DEVICE_HUB_SCREENSHOT_METADATA = "1";
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const png = await real.readFile(
        new URL("../../../Sources/SimPasteboard/Icons/AppIcon60x60@2x.png", import.meta.url),
      );
      const result = await saveScreenshotArtifact(png, directory);
      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("expected a failed save");
      expect(result.error).toBe("ENOSPC");
      const record = basename(result.file).replace(/\.png$/, ".failed.json");
      expect(await real.readdir(directory)).toEqual([record]);
      expect(JSON.parse(await real.readFile(join(directory, record), "utf8"))).toMatchObject({
        file: basename(result.file),
        error: "sidecar disk full",
      });
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.EXPO_DEVICE_HUB_SCREENSHOT_METADATA;
      else process.env.EXPO_DEVICE_HUB_SCREENSHOT_METADATA = previous;
      await real.rm(directory, { recursive: true, force: true });
    }
  },
);
