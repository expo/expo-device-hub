import { describe, expect, test } from "bun:test";
import { parseDevicesJson } from "../parse-devices";

describe("parseDevicesJson", () => {
  test("returns the result.devices array", () => {
    const json = JSON.stringify({
      info: { outcome: "success" },
      result: {
        devices: [
          { identifier: "A", deviceProperties: { name: "KWPhone" } },
          { identifier: "B", deviceProperties: { name: "iPad" } },
        ],
      },
    });

    const devices = parseDevicesJson(json).value;

    expect(devices).toHaveLength(2);
    expect(devices[0]?.deviceProperties?.name).toBe("KWPhone");
  });

  test("returns an empty array when there are no devices", () => {
    expect(parseDevicesJson(JSON.stringify({ result: { devices: [] } })).value).toEqual([]);
  });

  test("returns an empty array when result is missing", () => {
    expect(parseDevicesJson(JSON.stringify({ info: {} })).value).toEqual([]);
  });

  test("returns an empty array when devices is not an array", () => {
    expect(parseDevicesJson(JSON.stringify({ result: { devices: { nope: true } } })).value).toEqual(
      [],
    );
  });

  test("drops non-object device entries", () => {
    const json = JSON.stringify({ result: { devices: [{ id: "A" }, null, 7, "x"] } });
    expect(parseDevicesJson(json).value).toHaveLength(1);
  });

  test("returns an empty array and the malformed JSON error", () => {
    const parsed = parseDevicesJson("{ not json");
    expect(parsed.value).toEqual([]);
    expect(parsed.error).not.toBeNull();
  });
});
