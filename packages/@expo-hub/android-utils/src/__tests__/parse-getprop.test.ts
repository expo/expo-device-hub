import { describe, expect, test } from "bun:test";
import { isEmulatorProps, parseGetprop, pickPhysicalProps } from "../parse-getprop";

const GETPROP_OUTPUT = `[ro.product.model]: [Pixel 6a]
[ro.product.manufacturer]: [Google]
[ro.build.version.release]: [17]
[ro.build.version.sdk]: [37]
[ro.build.display.id]: [CP2A.260605.012]
[ro.kernel.qemu]: []
[persist.sys.timezone]: [Europe/Berlin]
`;

describe("parseGetprop", () => {
  test("parses [key]: [value] lines", () => {
    const props = parseGetprop(GETPROP_OUTPUT);
    expect(props["ro.product.model"]).toBe("Pixel 6a");
    expect(props["ro.build.version.sdk"]).toBe("37");
  });

  test("preserves empty values", () => {
    expect(parseGetprop("[ro.kernel.qemu]: []")["ro.kernel.qemu"]).toBe("");
  });

  test("ignores lines that do not match the prop shape", () => {
    expect(parseGetprop("not a prop\n[ro.x]: [1]\n")).toEqual({ "ro.x": "1" });
  });

  test("returns an empty object for empty input", () => {
    expect(parseGetprop("")).toEqual({});
  });
});

describe("isEmulatorProps", () => {
  test("is true when ro.kernel.qemu is 1", () => {
    expect(isEmulatorProps({ "ro.kernel.qemu": "1" })).toBe(true);
  });

  test("falls back to ro.boot.qemu", () => {
    expect(isEmulatorProps({ "ro.boot.qemu": "1" })).toBe(true);
  });

  test("is false for physical devices", () => {
    expect(isEmulatorProps(parseGetprop(GETPROP_OUTPUT))).toBe(false);
    expect(isEmulatorProps({})).toBe(false);
  });
});

describe("pickPhysicalProps", () => {
  test("keeps only the curated keys", () => {
    expect(pickPhysicalProps(parseGetprop(GETPROP_OUTPUT))).toEqual({
      "ro.product.model": "Pixel 6a",
      "ro.product.manufacturer": "Google",
      "ro.build.version.release": "17",
      "ro.build.version.sdk": "37",
      "ro.build.display.id": "CP2A.260605.012",
    });
  });

  test("omits keys that are absent", () => {
    expect(pickPhysicalProps({ "ro.product.model": "X" })).toEqual({ "ro.product.model": "X" });
  });
});
