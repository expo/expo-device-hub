import { describe, expect, test } from "bun:test";
import { parseDeviceProfiles } from "../parse-device-profiles";

const DEVICE_LIST_OUTPUT = `Available devices definitions:
id: 0 or "ai_glasses_device"
    Name: AI Glasses
    OEM : Google
    Tag : ai-glasses
---------
id: 10 or "Galaxy Nexus"
    Name: Galaxy Nexus
    OEM : Google
---------
id: 13 or "medium_phone"
    Name: Medium Phone
    OEM : Generic
---------
id: 80 or "5.4in FWVGA"
    Name: 5.4" FWVGA
    OEM : Generic
`;

describe("parseDeviceProfiles", () => {
  test("parses every device profile block in order", () => {
    const profiles = parseDeviceProfiles(DEVICE_LIST_OUTPUT);
    expect(profiles.map((profile) => profile.id)).toEqual([
      "ai_glasses_device",
      "Galaxy Nexus",
      "medium_phone",
      "5.4in FWVGA",
    ]);
  });

  test("extracts the id, index, name, oem and tag of a block", () => {
    const [first] = parseDeviceProfiles(DEVICE_LIST_OUTPUT);
    expect(first).toEqual({
      id: "ai_glasses_device",
      index: 0,
      name: "AI Glasses",
      oem: "Google",
      tag: "ai-glasses",
    });
  });

  test("parses multi-digit numeric indices", () => {
    expect(parseDeviceProfiles(DEVICE_LIST_OUTPUT)[1]?.index).toBe(10);
  });

  test("sets tag to null when the block has no Tag line", () => {
    const galaxy = parseDeviceProfiles(DEVICE_LIST_OUTPUT)[1];
    expect(galaxy?.tag).toBeNull();
    expect(galaxy?.oem).toBe("Google");
  });

  test("keeps quoted ids and names with spaces and quote characters intact", () => {
    const fwvga = parseDeviceProfiles(DEVICE_LIST_OUTPUT)[3];
    expect(fwvga?.id).toBe("5.4in FWVGA");
    expect(fwvga?.name).toBe(`5.4" FWVGA`);
  });

  test("skips blocks without an id line", () => {
    const output = `Available devices definitions:
    Name: Orphan
    OEM : Google
---------
id: 1 or "pixel"
    Name: Pixel
    OEM : Google
`;
    expect(parseDeviceProfiles(output).map((profile) => profile.id)).toEqual(["pixel"]);
  });

  test("returns an empty array when there are no devices", () => {
    expect(parseDeviceProfiles("")).toEqual([]);
    expect(parseDeviceProfiles("Available devices definitions:\n")).toEqual([]);
  });
});
