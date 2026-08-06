import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAvdLastBootedAt } from "../avd-usage";

describe("readAvdLastBootedAt", () => {
  test("reads the boot-completion marker mtime as epoch milliseconds", async () => {
    const avdPath = await mkdtemp(join(tmpdir(), "hub-android-avd-"));
    const markerPath = join(avdPath, "bootcompleted.ini");
    const lastBootedAt = new Date("2026-08-03T21:53:24Z");

    try {
      await writeFile(markerPath, "");
      await utimes(markerPath, lastBootedAt, lastBootedAt);

      expect(await readAvdLastBootedAt(avdPath)).toEqual({
        value: lastBootedAt.getTime(),
        error: null,
      });
    } finally {
      await rm(avdPath, { recursive: true, force: true });
    }
  });

  test("returns null when the AVD path or boot marker is absent", async () => {
    const avdPath = await mkdtemp(join(tmpdir(), "hub-android-avd-"));

    try {
      expect(await readAvdLastBootedAt(null)).toEqual({ value: null, error: null });
      expect(await readAvdLastBootedAt(avdPath)).toEqual({ value: null, error: null });
    } finally {
      await rm(avdPath, { recursive: true, force: true });
    }
  });
});
