import { describe, expect, spyOn, test } from "bun:test";
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

    const devices = parseDevicesJson(json);

    expect(devices).toHaveLength(2);
    expect(devices[0]?.deviceProperties?.name).toBe("KWPhone");
  });

  test("returns an empty array when there are no devices", () => {
    expect(parseDevicesJson(JSON.stringify({ result: { devices: [] } }))).toEqual([]);
  });

  test("returns an empty array when result is missing", () => {
    expect(parseDevicesJson(JSON.stringify({ info: {} }))).toEqual([]);
  });

  test("returns an empty array when devices is not an array", () => {
    expect(parseDevicesJson(JSON.stringify({ result: { devices: { nope: true } } }))).toEqual([]);
  });

  test("drops non-object device entries", () => {
    const json = JSON.stringify({ result: { devices: [{ id: "A" }, null, 7, "x"] } });
    expect(parseDevicesJson(json)).toHaveLength(1);
  });

  test("returns an empty array and logs on malformed JSON", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(parseDevicesJson("{ not json")).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
