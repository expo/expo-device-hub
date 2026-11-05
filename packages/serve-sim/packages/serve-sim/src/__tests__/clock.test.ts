import { describe, expect, test } from "bun:test";
import { HOST_CLOCK, clockTarget, clockValue, normalizeClock, zoneWallTime } from "../clock";

describe("normalizeClock", () => {
  test("folds the host aliases", () => {
    for (const value of ["host", "Reset", " default "])
      expect(normalizeClock(value)).toBe(HOST_CLOCK);
  });

  test("keeps a date and time without a zone, to read in the simulator's zone", () => {
    expect(normalizeClock("2030-01-01T09:00")).toBe("2030-01-01T09:00:00");
    expect(normalizeClock("2030-01-01 09:00:30")).toBe("2030-01-01T09:00:30");
  });

  test("turns a date and time with a zone into UTC", () => {
    expect(normalizeClock("2030-01-01T09:00Z")).toBe("2030-01-01T09:00:00Z");
    expect(normalizeClock("2030-01-01T09:00:00+09:00")).toBe("2030-01-01T00:00:00Z");
    expect(normalizeClock("2030-01-01T09:00:00.250-0130")).toBe("2030-01-01T10:30:00Z");
  });

  test("refuses anything that is not one date and time", () => {
    for (const value of [
      "",
      "--help",
      "tomorrow",
      "2030-01-01",
      "2030-02-30T09:00",
      "2030-01-01T24:00",
      "2030-01-01T09:60",
      "2030-01-01T09:00+25:00",
      "12030-01-01T09:00",
    ]) {
      expect(normalizeClock(value)).toBeNull();
    }
  });
});

describe("clockTarget", () => {
  test("reads a value without a zone in the given zone", () => {
    expect(clockTarget("2030-01-01T09:00:00", "Asia/Tokyo")).toBe(Date.UTC(2030, 0, 1, 0, 0, 0));
    // Daylight saving time: New York is UTC-4 in July.
    expect(clockTarget("2030-07-01T12:00:00", "America/New_York")).toBe(
      Date.UTC(2030, 6, 1, 16, 0, 0),
    );
    expect(clockTarget("2030-01-01T12:00:00", "America/New_York")).toBe(
      Date.UTC(2030, 0, 1, 17, 0, 0),
    );
  });

  test("is null for a wall time that daylight saving time skips", () => {
    expect(clockTarget("2030-03-10T02:30:00", "America/New_York")).toBeNull();
    expect(clockTarget("2030-03-31T02:30:00", "Europe/Berlin")).toBeNull();
  });

  test("takes the first of a wall time that repeats when daylight saving time ends", () => {
    // 01:30 happens twice in New York on 2030-11-03: first at UTC-4.
    expect(clockTarget("2030-11-03T01:30:00", "America/New_York")).toBe(
      Date.UTC(2030, 10, 3, 5, 30),
    );
    // East of UTC too: Berlin repeats 02:30 on 2030-10-27, first at UTC+2.
    expect(clockTarget("2030-10-27T02:30:00", "Europe/Berlin")).toBe(Date.UTC(2030, 9, 27, 0, 30));
    // Sydney repeats 02:30 on 2030-04-07, first at UTC+11.
    expect(clockTarget("2030-04-07T02:30:00", "Australia/Sydney")).toBe(
      Date.UTC(2030, 3, 6, 15, 30),
    );
  });

  test("ignores the zone for a UTC value", () => {
    expect(clockTarget("2030-01-01T00:00:00Z", "Asia/Tokyo")).toBe(Date.UTC(2030, 0, 1));
  });
});

describe("clockValue", () => {
  test("reports host for no offset, else the shifted time now in the zone, with its offset", () => {
    const now = Date.UTC(2026, 10, 3, 5, 0, 0, 400);
    expect(clockValue(0, now, "Asia/Tokyo")).toBe(HOST_CLOCK);
    expect(clockValue(86_400_000, now, "Asia/Tokyo")).toBe("2026-11-04T14:00:00+09:00");
    expect(clockValue(-3_600_000, now, "America/St_Johns")).toBe("2026-11-03T00:30:00-03:30");
    // UTC itself says so; a zone that is at +00:00 now keeps its offset.
    expect(clockValue(1_000, now, "UTC")).toBe("2026-11-03T05:00:01Z");
    expect(clockValue(1_000, Date.UTC(2026, 0, 1), "Europe/London")).toBe(
      "2026-01-01T00:00:01+00:00",
    );
  });

  test("reports UTC when the zone's offset has seconds", () => {
    // Monrovia was 44 minutes 30 seconds behind UTC until 1972.
    expect(clockValue(1_000, Date.UTC(1971, 0, 1), "Africa/Monrovia")).toBe("1971-01-01T00:00:01Z");
  });

  test("reports a value that sets the same time again", () => {
    const now = Date.UTC(2026, 10, 3, 5, 0, 0);
    const value = clockValue(86_400_000, now, "Asia/Kolkata");
    expect(Date.parse(normalizeClock(value)!)).toBe(now + 86_400_000);
  });
});

describe("zoneWallTime", () => {
  test("is the zone's wall time at an instant", () => {
    const at = Date.UTC(2026, 10, 3, 5, 0, 30, 900);
    expect(zoneWallTime("Asia/Tokyo", at)).toBe("2026-11-03T14:00:30");
    expect(zoneWallTime("America/New_York", at)).toBe("2026-11-03T00:00:30");
  });
});
