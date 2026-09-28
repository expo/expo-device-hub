import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveScreenshotArtifact } from "../screenshot-artifacts";

describe("screenshot artifacts", () => {
  test("uses readable UTC timestamps and keeps simultaneous captures distinct", async () => {
    const directory = await mkdtemp(join(tmpdir(), "screenshot-test-"));
    setSystemTime(new Date("2026-09-24T08:45:59.123Z"));
    try {
      const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const results = await Promise.all([
        saveScreenshotArtifact(png, directory),
        saveScreenshotArtifact(png, directory),
      ]);
      const files = await readdir(directory);
      expect(files).toHaveLength(2);
      expect(results.map((result) => (result.status === "saved" ? result.file : null)).sort()).toEqual(
        files.map((file) => join(directory, file)).sort(),
      );
      for (const file of files) {
        expect(file).toMatch(/^screenshot-2026-09-24T08-45-59-123Z-[a-f0-9]{12}\.png$/);
        expect(new Uint8Array(await readFile(join(directory, file)))).toEqual(png);
      }
    } finally {
      setSystemTime();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("logs persistence failures and still resolves", async () => {
    const directory = await mkdtemp(join(tmpdir(), "screenshot-test-"));
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const file = join(directory, "file");
      await writeFile(file, "occupied");
      const result = await saveScreenshotArtifact(new Uint8Array(), file);
      expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/EEXIST|ENOTDIR/) });
      expect(result.status === "failed" && result.file.startsWith(join(file, "screenshot-"))).toBe(true);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain(join(file, "screenshot-"));
    } finally {
      consoleError.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("returns disabled when no artifact directory is configured", async () => {
    expect(await saveScreenshotArtifact(new Uint8Array(), "")).toEqual({ status: "disabled" });
  });
});
