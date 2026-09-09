import { describe, expect, test } from "bun:test";
import { getUpdateNotice, isNewerVersion, UPDATE_CHECK_INTERVAL_MS, type UpdateCache } from "../src/update-check.ts";

describe("isNewerVersion", () => {
  test("compares semver-like versions", () => {
    expect(isNewerVersion("0.0.4", "0.0.3")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.0.9")).toBe(true);
    expect(isNewerVersion("0.0.3", "0.0.3")).toBe(false);
    expect(isNewerVersion("0.0.2", "0.0.3")).toBe(false);
  });
});

describe("getUpdateNotice", () => {
  test("returns a notice when the registry version is newer", async () => {
    const writes: UpdateCache[] = [];

    const notice = await getUpdateNotice({
      packageName: "serve-emu",
      currentVersion: "0.0.3",
      now: () => 1000,
      readCache: async () => null,
      writeCache: async (_path, cache) => {
        writes.push(cache);
      },
      fetchLatest: async () => "0.0.4",
    });

    expect(notice).toBe("Update available: serve-emu 0.0.3 -> 0.0.4\nRun: bunx serve-emu@latest");
    expect(writes).toEqual([{ checkedAt: 1000, latestVersion: "0.0.4" }]);
  });

  test("uses fresh cached versions without fetching", async () => {
    let fetches = 0;

    const notice = await getUpdateNotice({
      packageName: "serve-emu",
      currentVersion: "0.0.3",
      now: () => UPDATE_CHECK_INTERVAL_MS,
      readCache: async () => ({ checkedAt: 1, latestVersion: "0.0.4" }),
      fetchLatest: async () => {
        fetches += 1;
        return "0.0.5";
      },
    });

    expect(notice).toBe("Update available: serve-emu 0.0.3 -> 0.0.4\nRun: bunx serve-emu@latest");
    expect(fetches).toBe(0);
  });

  test("does not return a notice when already current", async () => {
    const notice = await getUpdateNotice({
      packageName: "serve-emu",
      currentVersion: "0.0.3",
      readCache: async () => null,
      writeCache: async () => {},
      fetchLatest: async () => "0.0.3",
    });

    expect(notice).toBeNull();
  });
});
