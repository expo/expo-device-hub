import { describe, expect, test } from "bun:test";

import {
  CUSTOM_PRESET,
  draftFromFix,
  formatFix,
  LOCATION_PRESETS,
  parseGeoFixInput,
  PRESET_OPTIONS,
  presetFix,
  presetFor,
  splitPastedPair,
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

  test("reports latitude before longitude when both are bad", () => {
    expect(parseGeoFixInput({ latitude: "north", longitude: "west" })).toEqual({
      ok: false,
      error: { field: "latitude", message: LATITUDE_MESSAGE },
    });
  });
});

describe("splitPastedPair", () => {
  const current = { latitude: "1", longitude: "2" };

  test("a pair pasted into latitude fills both fields", () => {
    expect(splitPastedPair("latitude", "37.3349, -122.0090", current)).toEqual({
      latitude: "37.3349",
      longitude: "-122.0090",
    });
  });

  test("a pair pasted into longitude fills both fields", () => {
    expect(splitPastedPair("longitude", "37.3349, -122.0090", current)).toEqual({
      latitude: "37.3349",
      longitude: "-122.0090",
    });
  });

  test("a plain edit leaves the sibling field alone", () => {
    expect(splitPastedPair("longitude", "-122.00", current)).toEqual({
      latitude: "1",
      longitude: "-122.00",
    });
  });

  test("a trailing comma with nothing after it stays a plain edit", () => {
    expect(splitPastedPair("latitude", "37.3349,", current)).toEqual({
      latitude: "37.3349,",
      longitude: "2",
    });
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
