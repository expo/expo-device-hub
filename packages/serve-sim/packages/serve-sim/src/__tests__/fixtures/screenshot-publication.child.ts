import { afterAll, expect, mock, test } from "bun:test";
import * as childProcess from "child_process";
import * as promises from "fs/promises";
import { readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { SCREENSHOT_DIR } from "../../host-paths";
import { UDID } from "../helpers";

const originalStat = promises.stat;
const name = "serve-sim-screenshot-publication-race.png";
const staged = join(SCREENSHOT_DIR, name);
let failCapture!: () => void;
let finishCapture!: () => void;
let bothStarted!: () => void;
const ready = new Promise<void>((resolve) => {
  bothStarted = resolve;
});
let invocations = 0;
let interleaved = false;
mock.module("child_process", () => ({
  ...childProcess,
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    done: (...args: unknown[]) => void,
  ) => {
    if (file === "cp") {
      queueMicrotask(() => done(null, "", ""));
      return {};
    }
    expect(file).toBe("xcrun");
    if (++invocations === 1)
      failCapture = () => done(Object.assign(new Error("failed"), { code: 1 }), "", "failed");
    else {
      writeFileSync(args.at(-1)!, "VALID PNG");
      finishCapture = () => done(null, "", "");
      bothStarted();
    }
    return {};
  },
}));
mock.module("fs/promises", () => ({
  ...promises,
  stat: async (path: string) => {
    const info = await originalStat(path);
    if (path === staged && info.size === 0 && !interleaved) {
      interleaved = true;
      // A has observed its empty reservation. Let B attempt to publish before A removes it.
      finishCapture();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return info;
  },
  // Make the competing atomic rename complete within that controlled interleaving.
  rename: async (from: string, to: string) => renameSync(from, to),
}));
const { captureScreenshotAsync } = await import("../../screenshot-store");
afterAll(() => promises.rm(staged, { force: true }));

test("failed reservation cleanup cannot remove a concurrent successful publication", async () => {
  await promises.rm(staged, { force: true });
  const first = captureScreenshotAsync({ udid: UDID, fileName: name, display: 1 });
  const second = captureScreenshotAsync({ udid: UDID, fileName: name, display: 1 });
  await ready;
  failCapture();
  const results = await Promise.all([first, second]);
  expect(interleaved).toBe(true);
  expect(results.map((r) => r.exitCode)).toEqual([1, 0]);
  expect(readFileSync(results[1]!.stdout, "utf8")).toBe("VALID PNG");
});
