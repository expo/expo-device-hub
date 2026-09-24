import { describe, expect, test, beforeEach } from "bun:test";
import {
  clearEventLogForTests,
  EVENT_LOG_MAX_ENTRIES,
  eventLogEventForAction,
  eventLogEventForHidMessage,
  readEventLog,
  recordEventLogEvent,
  subscribeEventLog,
  updateEventLogEvent,
} from "../event-log";

beforeEach(() => {
  clearEventLogForTests();
});

describe("eventLogEventForAction", () => {
  test("records an install", () => {
    expect(eventLogEventForAction("app.install", { udid: "DEVICE-A" }, { exitCode: 0 })).toMatchObject(
      { device: "DEVICE-A", kind: "app", action: "install", summary: "Install app" },
    );
  });

  test("records the actions the preview drives", () => {
    const cases: [string, string][] = [
      ["media.add", "media"],
      ["screenshot.capture", "screenshot"],
      ["rotate", "rotate"],
      ["button", "button"],
      ["camera.switch", "camera"],
      ["home.springboard", "button"],
      ["home.watch", "button"],
    ];
    for (const [action, kind] of cases) {
      const event = eventLogEventForAction(action, { udid: "DEVICE-A", value: "home" }, { exitCode: 0 });
      expect(event).not.toBeNull();
      expect(event?.kind).toBe(kind);
    }
  });

  // The log stream is filtered per device, so an entry without one is dropped before anyone sees it.
  test("returns null without a device", () => {
    expect(eventLogEventForAction("button", { value: "home" }, { exitCode: 0 })).toBeNull();
  });

  test("records nothing for an action the log does not describe", () => {
    expect(eventLogEventForAction("file.readBase64", { udid: "DEVICE-A" }, { exitCode: 0 })).toBeNull();
  });

  // Params can carry a host path or a token; only the exit status belongs in the log.
  test("keeps action params out of the recorded details", () => {
    const event = eventLogEventForAction(
      "media.add",
      { udid: "DEVICE-A", path: "/Users/someone/Desktop/secret.png" },
      { exitCode: 0 },
    );

    expect(JSON.stringify(event)).not.toContain("secret.png");
  });
});

describe("event log store", () => {
  test("records entries in order and filters by device", () => {
    recordEventLogEvent({
      device: "DEVICE-A",
      source: "hid",
      kind: "button",
      action: "home",
      summary: "Home",
    });
    recordEventLogEvent({
      device: "DEVICE-B",
      source: "hid",
      kind: "button",
      action: "volume-up",
      summary: "Button volume-up",
    });

    expect(readEventLog().map((event) => event.id)).toEqual([1, 2]);
    expect(readEventLog().map((event) => event.msg)).toEqual(["Home", "Button volume-up"]);
    expect(readEventLog({ device: "DEVICE-B" }).map((event) => event.summary)).toEqual([
      "Button volume-up",
    ]);
  });

  test("keeps a bunyan-style msg field on recorded entries", () => {
    recordEventLogEvent({
      source: "exec",
      kind: "button",
      action: "home",
      summary: "Home",
    });
    recordEventLogEvent({
      source: "exec",
      kind: "button",
      action: "home",
      summary: "Home",
      msg: "Pressed Home",
    });

    expect(readEventLog()).toMatchObject([
      { summary: "Home", msg: "Home" },
      { summary: "Home", msg: "Pressed Home" },
    ]);
  });

  test("supports since and limit reads", () => {
    for (let i = 0; i < 5; i++) {
      recordEventLogEvent({
        source: "exec",
        kind: "button",
        summary: `Event ${i}`,
      });
    }

    expect(readEventLog({ sinceId: 2 }).map((event) => event.id)).toEqual([3, 4, 5]);
    expect(readEventLog({ limit: 2 }).map((event) => event.id)).toEqual([4, 5]);
  });

  test("keeps only the newest entries when the store reaches its cap", () => {
    for (let i = 0; i < EVENT_LOG_MAX_ENTRIES + 3; i++) {
      recordEventLogEvent({
        source: "exec",
        kind: "button",
        summary: `Event ${i}`,
      });
    }

    const events = readEventLog();
    expect(events).toHaveLength(EVENT_LOG_MAX_ENTRIES);
    expect(events[0]).toMatchObject({ id: 4, summary: "Event 3" });
    expect(events.at(-1)).toMatchObject({
      id: EVENT_LOG_MAX_ENTRIES + 3,
      summary: `Event ${EVENT_LOG_MAX_ENTRIES + 2}`,
    });
  });

  test("notifies subscribers as entries are recorded", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeEventLog((event) => seen.push(event.summary));
    recordEventLogEvent({ source: "exec", kind: "button", summary: "Home" });
    unsubscribe();
    recordEventLogEvent({ source: "exec", kind: "button", summary: "Ignored" });
    expect(seen).toEqual(["Home"]);
  });

  test("updates entries in place and notifies subscribers", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeEventLog((event) => seen.push(event.summary));
    const entry = recordEventLogEvent({
      source: "hid",
      kind: "touch",
      action: "begin",
      summary: "Touch begin 0.1,0.2",
    });

    updateEventLogEvent(entry.id, {
      kind: "tap",
      action: "tap",
      summary: "Tap 0.1,0.2",
    });
    unsubscribe();

    expect(readEventLog()).toMatchObject([
      { id: entry.id, kind: "tap", action: "tap", summary: "Tap 0.1,0.2", msg: "Tap 0.1,0.2" },
    ]);
    expect(seen).toEqual(["Touch begin 0.1,0.2", "Tap 0.1,0.2"]);
  });

  test("can update entries without notifying subscribers", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeEventLog((event) => seen.push(event.summary));
    const entry = recordEventLogEvent({
      source: "hid",
      kind: "drag",
      action: "drag",
      summary: "Drag 0.1,0.2 -> 0.3,0.4",
    });

    updateEventLogEvent(
      entry.id,
      {
        summary: "Drag 0.1,0.2 -> 0.5,0.6",
      },
      { notify: false },
    );
    unsubscribe();

    expect(readEventLog()).toMatchObject([
      {
        id: entry.id,
        summary: "Drag 0.1,0.2 -> 0.5,0.6",
        msg: "Drag 0.1,0.2 -> 0.5,0.6",
      },
    ]);
    expect(seen).toEqual(["Drag 0.1,0.2 -> 0.3,0.4"]);
  });
});

describe("eventLogEventForHidMessage", () => {
  test("describes hinge positions", () => {
    for (const [angle, summary] of [[0, "Fold"], [90, "Half Fold"], [180, "Unfold"]] as const) {
      expect(eventLogEventForHidMessage("UDID", 0x0f, { angle })).toMatchObject({
        kind: "hinge",
        action: "set-angle",
        summary,
        details: { angle },
      });
    }
    expect(eventLogEventForHidMessage("UDID", 0x0f, { angle: 45 })?.summary).toBe("Hinge 45°");
    expect(eventLogEventForHidMessage("UDID", 0x0f, { angle: "90" })).toBeNull();
  });

  test("distinguishes physical poses, fine angles, and Table Mode", () => {
    for (const [control, value, summary] of [
      ["pose", "laptop", "Laptop"],
      ["pose", "book", "Book"],
      ["angle", 42.5, "Hinge 42.5°"],
      ["table", true, "Table Mode on"],
      ["physical", "faceup", "Physical orientation face up"],
      ["physical", "facedown", "Physical orientation face down"],
    ] as const) {
      expect(eventLogEventForHidMessage("UDID", 0x10, { control, value, extra: "not logged" })).toMatchObject({
        kind: "hinge", action: `set-${control}`, summary, details: { control, value },
      });
      expect(eventLogEventForHidMessage("UDID", 0x10, { control, value, extra: "not logged" })?.details).not.toHaveProperty("extra");
    }
    expect(eventLogEventForHidMessage("UDID", 0x10, { control: "pose", value: "invalid" })).toBeNull();
  });

  test("maps button HID payloads", () => {
    expect(
      eventLogEventForHidMessage("UDID", 0x04, {
        button: "volume-up",
        page: 12,
        usage: 233,
        phase: "down",
      }),
    ).toMatchObject({
      device: "UDID",
      source: "hid",
      kind: "button",
      action: "volume-up",
      summary: "Button volume-up down",
    });
  });

  test("maps touch payloads with screen details", () => {
    expect(
      eventLogEventForHidMessage("UDID", 0x03, { type: "begin", x: 0.5, y: 0.9 }, {
        width: 390,
        height: 844,
      }),
    ).toMatchObject({
      device: "UDID",
      source: "hid",
      kind: "touch",
      action: "begin",
      summary: "Touch begin 0.5,0.9",
      details: { screen: { width: 390, height: 844 } },
    });
  });

  test("redacts printable key HID usages", () => {
    for (const usage of [23, 0x1e, 0x2d]) {
      const event = eventLogEventForHidMessage("UDID", 0x06, { type: "up", usage });
      expect(event).toMatchObject({
        device: "UDID",
        source: "hid",
        kind: "key",
        action: "up",
        summary: "Key up character",
        details: { key: "character", redacted: true },
      });
      expect("usage" in event!.details!).toBe(false);
    }
  });

  test("maps non-printable key HID usages to readable labels", () => {
    expect(
      eventLogEventForHidMessage("UDID", 0x06, { type: "down", usage: 0x28 }),
    ).toMatchObject({
      summary: "Key down Enter",
      details: { usage: 0x28, key: "Enter" },
    });
  });

  // A HID payload reaches `summary` unvalidated and `serve-sim event-log` prints it to a terminal,
  // where an escape sequence would be interpreted rather than shown.
  test("strips control characters from what an operator will see", () => {
    const entry = recordEventLogEvent({
      device: "DEVICE-A",
      source: "hid",
      kind: "button",
      action: `home\u001b[2J`,
      status: "ok",
      summary: `Button home\u001b[31mred\u001b[0m`,
    });

    for (const field of [entry.summary, entry.msg, entry.action]) {
      expect(String(field)).not.toContain("\u001b");
    }
    expect(entry.summary).toContain("Button home");
  });

  test("bounds how much of an attacker's string it keeps", () => {
    const entry = recordEventLogEvent({
      device: "DEVICE-A",
      source: "hid",
      kind: "button",
      status: "ok",
      summary: `Button ${"A".repeat(5000)}`,
    });
    expect(entry.summary.length).toBeLessThanOrEqual(256);
  });
});
