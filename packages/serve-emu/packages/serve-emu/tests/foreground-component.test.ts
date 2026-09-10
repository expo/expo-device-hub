import { describe, expect, test } from "bun:test";
import {
  FOREGROUND_ACTIVITY_GREP,
  FOREGROUND_WINDOW_GREP,
  parseForegroundActivityDump,
  parseForegroundWindowDump,
} from "../src/foreground-component.ts";

const WINDOW_LINES = [
  "  mCurrentFocus=Window{42 u0 com.example.app/.MainActivity}",
  "  mFocusedApp=ActivityRecord{7 u0 com.example.focused/com.example.focused.Home t3}",
  "  mInputMethodTarget=Window{77 u0 com.example.ime/.KeyboardActivity}",
];

const ACTIVITY_LINES = [
  "  topResumedActivity=ActivityRecord{1 u0 com.example.top/.TopActivity t1}",
  "  mResumedActivity: ActivityRecord{2 u0 com.example.resumed/.Home t2}",
  "  ResumedActivity: ActivityRecord{3 u0 com.example.bare/.Bare t3}",
];

describe("foreground component detectors", () => {
  test("reads the package and expands a relative activity", () => {
    expect(parseForegroundWindowDump(WINDOW_LINES[0]!)).toEqual({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity",
    });
    expect(parseForegroundActivityDump(ACTIVITY_LINES[0]!)).toEqual({
      packageName: "com.example.top",
      activity: "com.example.top.TopActivity",
    });
  });

  test("prefers the earlier detector when a dump carries several", () => {
    expect(parseForegroundWindowDump(WINDOW_LINES.join("\n"))?.packageName).toBe("com.example.app");
    expect(parseForegroundWindowDump([...WINDOW_LINES].reverse().join("\n"))?.packageName).toBe(
      "com.example.app",
    );
    expect(parseForegroundActivityDump([...ACTIVITY_LINES].reverse().join("\n"))?.packageName).toBe(
      "com.example.top",
    );
  });

  test("the probe grep alternation keeps every line a detector reads", () => {
    const windowFilter = new RegExp(FOREGROUND_WINDOW_GREP);
    for (const line of WINDOW_LINES) {
      expect(parseForegroundWindowDump(line)).not.toBeNull();
      expect(windowFilter.test(line)).toBe(true);
    }
    const activityFilter = new RegExp(FOREGROUND_ACTIVITY_GREP);
    for (const line of ACTIVITY_LINES) {
      expect(parseForegroundActivityDump(line)).not.toBeNull();
      expect(activityFilter.test(line)).toBe(true);
    }
  });

  test("returns null when no line names a component", () => {
    expect(parseForegroundWindowDump("mCurrentFocus=null")).toBeNull();
    expect(parseForegroundActivityDump("no resumed activity")).toBeNull();
    expect(
      parseForegroundActivityDump("ResumedActivity: ActivityRecord{3 u0 com.example.bare}"),
    ).toBeNull();
  });
});
