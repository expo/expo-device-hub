import { describe, expect, test } from "bun:test";
import { HOST_TIME_ZONE, normalizeTimeZone } from "../time-zone";

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
