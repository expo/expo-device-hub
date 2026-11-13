/// <reference types="bun" />

/**
 * The process table boot admission reads: `ps` output on Linux and macOS, and
 * which listed processes are running.
 */

import { describe, expect, test } from "bun:test";

import { isRunning, parseProcessTable } from "../process-table";

const NOV_1 = Date.UTC(2026, 10, 1, 2, 57, 24) / 1000;

describe("process table", () => {
  test("parses procps and BSD ps lines in the C locale and UTC, for one account", () => {
    const stdout = [
      "      1     0  1000 Ss   Mon Oct 26 21:08:10 2026 /usr/lib/systemd/systemd --user",
      "4100001     1  1000 S    Sun Nov  1 02:57:24 2026 /Users/me/Library/Android/sdk/emulator/emulator @Pixel_9 -port 5560",
      "  612     1  1000 Z    Sun Nov  1 02:57:24 2026 ",
      "  700     1   501 S    Sun Nov  1 02:57:24 2026 /opt/sdk/emulator/emulator @Other -port 5562",
      "",
    ].join("\n");

    expect(parseProcessTable(stdout, 1000)).toEqual([
      {
        pid: 1,
        ppid: 0,
        state: "Ss",
        started: Date.UTC(2026, 9, 26, 21, 8, 10) / 1000,
        args: "/usr/lib/systemd/systemd --user",
      },
      {
        pid: 4_100_001,
        ppid: 1,
        state: "S",
        started: NOV_1,
        args: "/Users/me/Library/Android/sdk/emulator/emulator @Pixel_9 -port 5560",
      },
      { pid: 612, ppid: 1, state: "Z", started: NOV_1, args: "" },
    ]);
  });

  test("an unrecognized line fails the read instead of dropping a process", () => {
    expect(() => parseProcessTable("  42 1 1000 S 1 Nov 2026 02:57:24 bun hub\n", 1000)).toThrow(
      "Unrecognized `ps` line",
    );
  });
});

describe("running processes", () => {
  const table = [
    { pid: 10, ppid: 1, state: "S", started: NOV_1, args: "bun hub" },
    { pid: 11, ppid: 1, state: "Z", started: NOV_1, args: "" },
  ];

  test("a pid runs with its start time, read up to 2 seconds apart", () => {
    expect(isRunning(table, { pid: 10, started: NOV_1 + 2 })).toBe(true);
    expect(isRunning(table, { pid: 10, started: NOV_1 - 600 })).toBe(false);
    expect(isRunning(table, { pid: 12, started: NOV_1 })).toBe(false);
  });

  test("without a start time the pid alone decides", () => {
    expect(isRunning(table, { pid: 10 })).toBe(true);
  });

  test("a zombie is not running", () => {
    expect(isRunning(table, { pid: 11, started: NOV_1 })).toBe(false);
  });
});
