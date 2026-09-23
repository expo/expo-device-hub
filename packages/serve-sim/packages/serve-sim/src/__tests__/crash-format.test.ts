import { crashStreamUrl } from "../client/utils/crash-format";
import { describe, expect, test } from "bun:test";
import type { CrashFrame } from "../crash/report";
import {
  collapseSystemFrames,
  crashDetailUrl,
  formatCrashAgo,
} from "../client/utils/crash-format";

function frame(appOwned: boolean, symbol = "sym"): CrashFrame {
  return { image: appOwned ? "Demo" : "libsystem", symbol, imageOffset: 0, imageUuid: null, appOwned };
}

describe("crashDetailUrl", () => {
  test("names the occurrence by key when it has one", () => {
    expect(crashDetailUrl("/crashes?device=B", "INC-1", 2, 12)).toBe("/crashes/INC-1?device=B&occurrence=2&key=12");
  });

  test("keeps the list query when fetching a record", () => {
    expect(crashDetailUrl("/crashes?device=B", "INC-1")).toBe("/crashes/INC-1?device=B");
  });

  test("adds occurrence without dropping device", () => {
    expect(crashDetailUrl("/.sim/crashes?device=B", "INC 1", 2)).toBe(
      "/.sim/crashes/INC%201?device=B&occurrence=2"
    );
  });
});

describe("formatCrashAgo", () => {
  test("returns empty when the crash has no parseable time", () => {
    expect(formatCrashAgo(null, 10_000)).toBe("");
  });

  test("speaks in seconds, then minutes, then hours", () => {
    expect(formatCrashAgo(90_000, 100_000)).toBe("10s ago");
    expect(formatCrashAgo(0, 120_000)).toBe("2m ago");
    expect(formatCrashAgo(0, 3_600_000)).toBe("1h ago");
  });
});

describe("collapseSystemFrames", () => {
  test("leaves a pure app or pure system stack alone", () => {
    const app = [frame(/* appOwned */ true), frame(/* appOwned */ true)];
    const system = [frame(/* appOwned */ false), frame(/* appOwned */ false), frame(/* appOwned */ false)];
    expect(collapseSystemFrames(app).map((row) => row.kind)).toEqual(["frame", "frame"]);
    expect(collapseSystemFrames(system).map((row) => row.kind)).toEqual(["frame", "frame", "frame"]);
  });

  test("keeps the crashing instruction and folds the system run under it", () => {
    const frames = [
      frame(/* appOwned */ false, "kill"),
      frame(/* appOwned */ false),
      frame(/* appOwned */ false),
      frame(/* appOwned */ true, "crash()"),
      frame(/* appOwned */ true),
    ];
    const rows = collapseSystemFrames(frames);
    expect(rows).toMatchObject([
      { kind: "frame", index: 0, frame: { symbol: "kill" } },
      {
        kind: "collapsed",
        start: 1,
        count: 2,
        frames: [
          { index: 1, frame: { appOwned: false } },
          { index: 2, frame: { appOwned: false } },
        ],
      },
      { kind: "frame", index: 3, frame: { symbol: "crash()" } },
      { kind: "frame", index: 4, frame: { appOwned: true } },
    ]);
  });

  test("does not collapse a single system frame between app frames", () => {
    const rows = collapseSystemFrames([
      frame(/* appOwned */ true),
      frame(/* appOwned */ false),
      frame(/* appOwned */ true),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["frame", "frame", "frame"]);
  });

  test("collapses a trailing system run of two or more", () => {
    const rows = collapseSystemFrames([
      frame(/* appOwned */ true),
      frame(/* appOwned */ false),
      frame(/* appOwned */ false),
      frame(/* appOwned */ false),
    ]);
    expect(rows).toMatchObject([
      { kind: "frame", index: 0, frame: { appOwned: true } },
      {
        kind: "collapsed",
        start: 1,
        count: 3,
        frames: [
          { index: 1, frame: { appOwned: false } },
          { index: 2, frame: { appOwned: false } },
          { index: 3, frame: { appOwned: false } },
        ],
      },
    ]);
  });
});


test("crash URLs normalize the trailing slash and replace an existing tail option", () => {
  expect(crashDetailUrl("/.sim/crashes/?device=U", "A")).toBe("/.sim/crashes/A?device=U");
  expect(crashStreamUrl("/.sim/crashes?device=U&tail=0", true)).toBe("/.sim/crashes?device=U&tail=1");
  expect(crashStreamUrl("/.sim/crashes?device=U&tail=1", false)).toBe("/.sim/crashes?device=U&tail=0");
});
