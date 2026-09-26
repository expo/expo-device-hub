import { describe, expect, test } from "bun:test";
import {
  HOST_TIME_ZONE,
  normalizeTimeZone,
  supportedTimeZones,
  timeZoneOffsetLabel,
} from "../time-zone";

describe("normalizeTimeZone", () => {
  test.each(["host", "HOST", "system", "default", "auto", "none", "reset", " host "])(
    "%p means the host zone",
    (value) => {
      expect(normalizeTimeZone(value)).toBe(HOST_TIME_ZONE);
    },
  );

  test.each(["UTC", "utc", "GMT", "Z", "zulu", "Etc/UTC", "etc/gmt"])("%p means UTC", (value) => {
    expect(normalizeTimeZone(value)).toBe("UTC");
  });

  test("matches IANA names case-insensitively and returns the canonical spelling", () => {
    expect(normalizeTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(normalizeTimeZone("asia/tokyo")).toBe("Asia/Tokyo");
    expect(normalizeTimeZone("AMERICA/ARGENTINA/BUENOS_AIRES")).toBe("America/Argentina/Buenos_Aires");
    expect(normalizeTimeZone("  Europe/Berlin\n")).toBe("Europe/Berlin");
  });

  test("passes legacy aliases through as a zone ICU accepts", () => {
    const zone = normalizeTimeZone("Asia/Calcutta");
    expect(zone).not.toBeNull();
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone! })).not.toThrow();
  });

  test.each(["", "   ", "Mars/Olympus_Mons", "Europe/Berlin; rm -rf /", "+0900", "+09:00", "-05:00", "Europe"])(
    "rejects %p",
    (value) => {
      expect(normalizeTimeZone(value)).toBeNull();
    },
  );
});

describe("supportedTimeZones", () => {
  test("covers the IANA database", () => {
    const zones = supportedTimeZones();
    expect(zones).toContain("UTC");
    expect(zones).toContain("Asia/Tokyo");
  });
});

describe("timeZoneOffsetLabel", () => {
  test("reports the offset in effect at the given instant", () => {
    expect(timeZoneOffsetLabel("America/New_York", new Date("2026-01-15T12:00:00Z"))).toBe("GMT-5");
    expect(timeZoneOffsetLabel("America/New_York", new Date("2026-07-15T12:00:00Z"))).toBe("GMT-4");
    expect(timeZoneOffsetLabel("Asia/Kolkata", new Date("2026-01-15T12:00:00Z"))).toBe("GMT+5:30");
  });

  test("is empty for a zone ICU does not know", () => {
    expect(timeZoneOffsetLabel("Mars/Olympus_Mons")).toBe("");
  });
});
