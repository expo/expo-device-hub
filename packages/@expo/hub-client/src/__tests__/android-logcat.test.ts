import { describe, expect, test } from "bun:test";

import { ANDROID_LOGCAT_LINE_EVENTS, parseAndroidLogcatLines } from "../android-logcat";

const LINE = "10-06 22:17:00.610   498   498 I HubLogProbe: probe-1";
const AT = "2026-10-06T20:17:00.698Z";

describe("parseAndroidLogcatLines", () => {
  test("listens for both the batched and the single-line event", () => {
    expect([...ANDROID_LOGCAT_LINE_EVENTS]).toEqual(["logs", "log"]);
  });

  test("reads every line of a batched logs event in order", () => {
    const batch = {
      lines: [
        { line: LINE, at: AT },
        { line: "second", at: AT },
      ],
      dropped: 0,
      totalDropped: 0,
      sourceDropped: 0,
    };
    expect(parseAndroidLogcatLines("logs", JSON.stringify(batch))).toEqual([LINE, "second"]);
  });

  test("a batch that only reports drops yields no lines", () => {
    expect(
      parseAndroidLogcatLines(
        "logs",
        JSON.stringify({ lines: [], dropped: 3, totalDropped: 3, sourceDropped: 0 }),
      ),
    ).toEqual([]);
  });

  test("skips malformed entries but keeps the rest of the batch", () => {
    expect(
      parseAndroidLogcatLines(
        "logs",
        JSON.stringify({ lines: [null, { line: 7 }, ["x"], { line: LINE }, "raw"] }),
      ),
    ).toEqual([LINE]);
  });

  test("reads the single line of a log event from older servers", () => {
    expect(parseAndroidLogcatLines("log", JSON.stringify({ line: LINE, at: AT }))).toEqual([LINE]);
  });

  test("drops unknown events, bad JSON and payloads of the wrong shape", () => {
    expect(parseAndroidLogcatLines("ready", JSON.stringify({ line: LINE }))).toEqual([]);
    expect(parseAndroidLogcatLines("error", JSON.stringify({ line: LINE }))).toEqual([]);
    expect(parseAndroidLogcatLines("logs", "{not json")).toEqual([]);
    expect(parseAndroidLogcatLines("logs", JSON.stringify({ lines: "x" }))).toEqual([]);
    expect(parseAndroidLogcatLines("logs", "null")).toEqual([]);
    expect(parseAndroidLogcatLines("log", JSON.stringify({ lines: [{ line: LINE }] }))).toEqual([]);
  });
});
