import { describe, expect, test } from "bun:test";
import {
  deviceLogMatches,
  formatLogClock,
  formatLogLine,
  parseDeviceLogEntry,
} from "../client/utils/device-log-format";

const sample = {
  timestamp: "2026-08-28 12:54:11.123456-0700",
  processImagePath:
    "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS.simruntime/Contents/Resources/RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard",
  senderImagePath: "/usr/lib/libobjc.A.dylib",
  subsystem: "com.apple.SpringBoard",
  category: "Icon",
  eventMessage: "icon layout changed",
  messageType: "Default",
  processID: 312,
};

describe("parseDeviceLogEntry", () => {
  test("reads process basename, library, pid, and message", () => {
    expect(parseDeviceLogEntry(sample)).toEqual({
      process: "SpringBoard",
      library: "libobjc.A.dylib",
      subsystem: "com.apple.SpringBoard",
      category: "Icon",
      message: "icon layout changed",
      level: "default",
      pid: 312,
      timestamp: "2026-08-28 12:54:11.123456-0700",
    });
  });

  test("falls back to senderImagePath when processImagePath is missing", () => {
    expect(
      parseDeviceLogEntry({
        senderImagePath: "/usr/lib/libobjc.A.dylib",
        eventMessage: "hello",
        messageType: "Error",
      })
    ).toEqual({
      process: "libobjc.A.dylib",
      library: "libobjc.A.dylib",
      subsystem: "",
      category: "",
      message: "hello",
      level: "error",
      pid: null,
      timestamp: "",
    });
  });

  test("drops entries with no eventMessage", () => {
    expect(parseDeviceLogEntry({ processImagePath: "/SpringBoard", eventMessage: "" })).toBeNull();
    expect(parseDeviceLogEntry(null)).toBeNull();
    expect(parseDeviceLogEntry("not json object")).toBeNull();
  });
});

describe("log level", () => {
  test("maps unified-log names and os_log type codes", () => {
    const levelOf = (messageType: unknown) =>
      parseDeviceLogEntry({ eventMessage: "x", messageType })?.level;
    expect(levelOf("Debug")).toBe("debug");
    expect(levelOf("Notice")).toBe("default");
    expect(levelOf(2)).toBe("debug");
    expect(levelOf(1)).toBe("info");
    expect(levelOf(0)).toBe("default");
    expect(levelOf(16)).toBe("error");
    expect(levelOf(17)).toBe("fault");
  });
});

describe("deviceLogMatches", () => {
  const line = parseDeviceLogEntry(sample)!;

  test("empty query matches", () => {
    expect(deviceLogMatches(line, "")).toBe(true);
    expect(deviceLogMatches(line, "  ")).toBe(true);
  });

  test("matches process, subsystem, category, message, library, or pid", () => {
    expect(deviceLogMatches(line, "spring")).toBe(true);
    expect(deviceLogMatches(line, "ICON")).toBe(true);
    expect(deviceLogMatches(line, "layout")).toBe(true);
    expect(deviceLogMatches(line, "libobjc")).toBe(true);
    expect(deviceLogMatches(line, "312")).toBe(true);
    expect(deviceLogMatches(line, "nope")).toBe(false);
  });
});

describe("log time", () => {
  test("parses Apple's unified-log timestamp", () => {
    expect(formatLogClock(sample.timestamp)).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  test("returns empty when the timestamp will not parse", () => {
    expect(formatLogClock("")).toBe("");
    expect(formatLogClock("not a date")).toBe("");
  });
});

describe("formatLogLine", () => {
  test("joins the fields a copy buffer wants", () => {
    const line = parseDeviceLogEntry(sample)!;
    const text = formatLogLine(line);
    expect(text).toContain("default");
    expect(text).toContain("SpringBoard [312]");
    expect(text).toContain("com.apple.SpringBoard:Icon");
    expect(text).toContain("icon layout changed");
  });
});
