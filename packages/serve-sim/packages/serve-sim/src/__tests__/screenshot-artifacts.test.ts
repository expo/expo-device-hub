import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { clientSafeErrorMessage, saveScreenshotArtifact, screenshotArtifactHeaders } from "../screenshot-artifacts";

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

  test("logs persistence failures, writes a failure record, and still resolves", async () => {
    const directory = await mkdtemp(join(tmpdir(), "screenshot-test-"));
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await saveScreenshotArtifact(null as unknown as Uint8Array, directory);
      if (result.status !== "failed") throw new Error(`expected a failed save, got ${result.status}`);
      expect(result.error).toBe("unknown error");
      expect(result.file.startsWith(join(directory, "screenshot-"))).toBe(true);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain(result.file);

      const png = basename(result.file);
      const recordName = png.replace(/\.png$/, ".failed.json");
      expect(recordName).toMatch(/^screenshot-.+-[a-f0-9]{12}\.failed\.json$/);
      expect(await readdir(directory)).toEqual([recordName]);
      const record = JSON.parse(await readFile(join(directory, recordName), "utf8"));
      expect(Object.keys(record).sort()).toEqual(["at", "error", "file"]);
      expect(record.file).toBe(png);
      expect(record.error).toContain('"data" argument');
      expect(Number.isNaN(Date.parse(record.at))).toBe(false);
    } finally {
      consoleError.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("logs the failure record error when the directory cannot be written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "screenshot-test-"));
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const file = join(directory, "file");
      await writeFile(file, "occupied");
      const result = await saveScreenshotArtifact(new Uint8Array(), file);
      if (result.status !== "failed") throw new Error(`expected a failed save, got ${result.status}`);
      expect(result.error).toMatch(/^E(EXIST|NOTDIR)$/);
      expect(result.file.startsWith(join(file, "screenshot-"))).toBe(true);
      expect(consoleError).toHaveBeenCalledTimes(2);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain(join(file, "screenshot-"));
      expect(String(consoleError.mock.calls[1]?.[0])).toStartWith(
        `could not write screenshot failure record ${join(file, "screenshot-")}`,
      );
      expect(String(consoleError.mock.calls[1]?.[0])).toEndWith(".failed.json:");
    } finally {
      consoleError.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps the host path out of the returned error but in the failure record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "screenshot-test-"));
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const nested = join(directory, "missing", "artifacts");
      await writeFile(join(directory, "missing"), "occupied");
      const result = await saveScreenshotArtifact(new Uint8Array(), nested);
      if (result.status !== "failed") throw new Error(`expected a failed save, got ${result.status}`);
      expect(result.error).toMatch(/^E(EXIST|NOTDIR)$/);
      expect(result.error).not.toContain(directory);
      expect(String(consoleError.mock.calls[0]?.[1])).toContain(directory);
    } finally {
      consoleError.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("clientSafeErrorMessage sends only an errno code, never the message", () => {
    const enospc = Object.assign(new Error("ENOSPC: no space left on device, open '/srv/artifacts/a.png.tmp'"), {
      code: "ENOSPC",
    });
    expect(clientSafeErrorMessage(enospc)).toBe("ENOSPC");
    const invalidArg = Object.assign(new TypeError('The "data" argument must be of type string'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
    expect(clientSafeErrorMessage(invalidArg)).toBe("unknown error");
    expect(clientSafeErrorMessage(new Error("open '/srv/artifacts/a.png.tmp' failed"))).toBe("unknown error");
    expect(clientSafeErrorMessage("boom")).toBe("unknown error");
  });

  test("returns disabled when no artifact directory is configured", async () => {
    expect(await saveScreenshotArtifact(new Uint8Array(), "")).toEqual({ status: "disabled" });
  });
});

describe("screenshot artifact headers", () => {
  test("report a saved or disabled capture with the status header only", () => {
    expect(screenshotArtifactHeaders({ status: "saved", file: "/tmp/shot.png" })).toEqual({
      "X-Expo-Screenshot-Artifact": "saved",
    });
    expect(screenshotArtifactHeaders({ status: "disabled" })).toEqual({
      "X-Expo-Screenshot-Artifact": "disabled",
    });
  });

  test("make the failure reason safe to send as a header value", () => {
    const headers = screenshotArtifactHeaders({
      status: "failed",
      file: "/tmp/shot.png",
      error: "EACCES:\tpermission denied\r\n  (zoë\u0007)  ",
    });
    expect(headers).toEqual({
      "X-Expo-Screenshot-Artifact": "failed",
      "X-Expo-Screenshot-Artifact-Error": "EACCES: permission denied (zo)",
    });
    expect(() => new Headers(headers)).not.toThrow();
  });

  test("cap the failure reason at 512 characters", () => {
    const headers = screenshotArtifactHeaders({ status: "failed", file: "/tmp/shot.png", error: "x".repeat(2000) });
    expect(headers["X-Expo-Screenshot-Artifact-Error"]).toHaveLength(512);
  });
});
