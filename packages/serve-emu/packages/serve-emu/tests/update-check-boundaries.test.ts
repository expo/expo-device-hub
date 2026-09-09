import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getUpdateNotice,
  isNewerVersion,
  UPDATE_CHECK_INTERVAL_MS,
} from "../src/update-check.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("update version boundaries", () => {
  test("normalizes prefixes, prereleases, missing fields, and non-numeric components", () => {
    expect(isNewerVersion("v1.2.4-beta.1", "1.2.3")).toBe(true);
    expect(isNewerVersion("1.2", "1.2.0")).toBe(false);
    expect(isNewerVersion("1.invalid.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.1")).toBe(false);
  });

  test("uses the default filesystem cache writer and reader", async () => {
    const directory = await mkdtemp(join(tmpdir(), "serve-emu-update-test-"));
    temporaryDirectories.push(directory);
    const cachePath = join(directory, "nested", "update-check.json");
    let fetches = 0;

    const first = await getUpdateNotice({
      packageName: "serve-emu",
      currentVersion: "1.0.0",
      cachePath,
      now: () => 10_000,
      fetchLatest: async () => {
        fetches += 1;
        return "1.1.0";
      },
    });
    expect(first).toContain("1.0.0 -> 1.1.0");
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({
      checkedAt: 10_000,
      latestVersion: "1.1.0",
    });

    const second = await getUpdateNotice({
      packageName: "serve-emu",
      currentVersion: "1.0.0",
      cachePath,
      now: () => 10_000 + UPDATE_CHECK_INTERVAL_MS - 1,
      fetchLatest: async () => {
        fetches += 1;
        return "2.0.0";
      },
    });
    expect(second).toContain("1.0.0 -> 1.1.0");
    expect(fetches).toBe(1);
  });

  test("recovers from a malformed cache and quietly handles an unavailable registry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "serve-emu-update-test-"));
    temporaryDirectories.push(directory);
    const cachePath = join(directory, "missing", "update-check.json");

    expect(
      await getUpdateNotice({
        packageName: "serve-emu",
        currentVersion: "1.0.0",
        cachePath,
        fetchLatest: async () => null,
      }),
    ).toBeNull();
  });
});
