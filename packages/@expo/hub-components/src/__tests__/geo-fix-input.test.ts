import { describe, expect, test } from "bun:test";

import {
  CUSTOM_PRESET,
  draftFromFix,
  formatFix,
  LOCATION_PRESETS,
  parseGeoFixInput,
  pastedPair,
  PRESET_OPTIONS,
  presetFix,
  presetFor,
} from "../dashboard/geoFixInput";

const LATITUDE_MESSAGE = "Latitude must be a number from -90 to 90";
const LONGITUDE_MESSAGE = "Longitude must be a number from -180 to 180";

describe("parseGeoFixInput", () => {
  test("accepts a valid draft and trims each field", () => {
    expect(parseGeoFixInput({ latitude: " 37.3349 ", longitude: "-122.0090" })).toEqual({
      ok: true,
      fix: { latitude: 37.3349, longitude: -122.009 },
    });
  });

  test("rejects an empty field", () => {
    expect(parseGeoFixInput({ latitude: "   ", longitude: "-122.009" })).toEqual({
      ok: false,
      error: { field: "latitude", message: LATITUDE_MESSAGE },
    });
  });

  test("rejects a non-numeric field", () => {
    expect(parseGeoFixInput({ latitude: "37.3349", longitude: "west" })).toEqual({
      ok: false,
      error: { field: "longitude", message: LONGITUDE_MESSAGE },
    });
  });

  test("accepts latitude exactly on each bound", () => {
    expect(parseGeoFixInput({ latitude: "-90", longitude: "0" })).toEqual({
      ok: true,
      fix: { latitude: -90, longitude: 0 },
    });
    expect(parseGeoFixInput({ latitude: "90", longitude: "0" })).toEqual({
      ok: true,
      fix: { latitude: 90, longitude: 0 },
    });
  });

  test("rejects latitude just outside each bound", () => {
    expect(parseGeoFixInput({ latitude: "-90.0001", longitude: "0" })).toEqual({
      ok: false,
      error: { field: "latitude", message: LATITUDE_MESSAGE },
    });
    expect(parseGeoFixInput({ latitude: "90.0001", longitude: "0" })).toEqual({
      ok: false,
      error: { field: "latitude", message: LATITUDE_MESSAGE },
    });
  });

  test("rejects longitude outside its range", () => {
    expect(parseGeoFixInput({ latitude: "0", longitude: "180.0001" })).toEqual({
      ok: false,
      error: { field: "longitude", message: LONGITUDE_MESSAGE },
    });
    expect(parseGeoFixInput({ latitude: "0", longitude: "-180.0001" })).toEqual({
      ok: false,
      error: { field: "longitude", message: LONGITUDE_MESSAGE },
    });
  });

  test("rejects the non-decimal syntax Number would otherwise accept", () => {
    for (const latitude of ["0x10", "1e1", "Infinity", "37,3349", "37deg"]) {
      expect(parseGeoFixInput({ latitude, longitude: "0" })).toEqual({
        ok: false,
        error: { field: "latitude", message: LATITUDE_MESSAGE },
      });
    }
  });

  test("accepts a leading sign, a bare fraction, and a trailing point", () => {
    expect(parseGeoFixInput({ latitude: "+51.5", longitude: ".5" })).toEqual({
      ok: true,
      fix: { latitude: 51.5, longitude: 0.5 },
    });
    expect(parseGeoFixInput({ latitude: "37.", longitude: "-0" })).toEqual({
      ok: true,
      fix: { latitude: 37, longitude: -0 },
    });
  });

  test("reports latitude before longitude when both are bad", () => {
    expect(parseGeoFixInput({ latitude: "north", longitude: "west" })).toEqual({
      ok: false,
      error: { field: "latitude", message: LATITUDE_MESSAGE },
    });
  });
});

describe("pastedPair", () => {
  test("a pasted pair becomes both fields, trimmed", () => {
    expect(pastedPair("37.3349, -122.0090")).toEqual({
      latitude: "37.3349",
      longitude: "-122.0090",
    });
  });

  test("text that is not a pair is left to the field it was pasted into", () => {
    expect(pastedPair("-122.00")).toBeNull();
    expect(pastedPair("37.3349,")).toBeNull();
    expect(pastedPair(",-122.009")).toBeNull();
    expect(pastedPair("37.3349, -122.0090, 12")).toBeNull();
  });
});

describe("draftFromFix", () => {
  test("a null fix is two empty fields", () => {
    expect(draftFromFix(null)).toEqual({ latitude: "", longitude: "" });
  });

  test("a fix becomes its two stringified numbers", () => {
    expect(draftFromFix({ latitude: 51.5072, longitude: -0.1276 })).toEqual({
      latitude: "51.5072",
      longitude: "-0.1276",
    });
  });
});

test("formatFix pads both coordinates to four decimals", () => {
  expect(formatFix({ latitude: 37.3349, longitude: -122.009 })).toBe("37.3349, -122.0090");
});

describe("presets", () => {
  test("every preset round-trips from its fix back to its own value", () => {
    for (const preset of LOCATION_PRESETS) {
      expect(presetFix(preset.value)).toEqual(preset.fix);
      expect(presetFor(draftFromFix(presetFix(preset.value)))).toBe(preset.value);
    }
  });

  test("presetFix has no fix for the custom value", () => {
    expect(presetFix(CUSTOM_PRESET)).toBeNull();
  });

  test("a hand-edited draft is custom", () => {
    expect(presetFor({ latitude: "37.3349", longitude: "-122.5" })).toBe(CUSTOM_PRESET);
  });

  test("an unparseable draft is custom", () => {
    expect(presetFor({ latitude: "", longitude: "" })).toBe(CUSTOM_PRESET);
  });

  test("the offered options are Custom then the four presets in order", () => {
    expect(PRESET_OPTIONS.map((option) => option.label)).toEqual([
      "Custom",
      "Apple Park",
      "London",
      "Tokyo",
      "Sydney",
    ]);
  });
});
