import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveScreenshotArtifact } from "./screenshot-artifacts.ts";

describe("screenshot artifacts", () => {
  test("publishes complete, unique PNGs for concurrent captures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "screenshot-test-"));
    try {
      const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
      await Promise.all([saveScreenshotArtifact(png, directory), saveScreenshotArtifact(png, directory)]);
      const files = await readdir(directory);
      expect(files).toHaveLength(2);
      for (const file of files) {
        expect(file).toMatch(/^screenshot-[a-f0-9-]{36}\.png$/);
        expect(new Uint8Array(await readFile(join(directory, file)))).toEqual(png);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("propagates persistence failures instead of reporting a saved capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "screenshot-test-"));
    try {
      const file = join(directory, "file");
      await writeFile(file, "occupied");
      await expect(saveScreenshotArtifact(new Uint8Array(), file)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not require artifact storage for standalone previews", async () => {
    await saveScreenshotArtifact(new Uint8Array(), "");
  });
});
