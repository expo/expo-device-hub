import { describe, expect, test } from "bun:test";
import { parseConfigIni } from "../parse-config-ini";

describe("parseConfigIni", () => {
  test("parses simple key=value pairs", () => {
    const config = parseConfigIni("AvdId=Television_720p\nPlayStore.enabled=false");
    expect(config.AvdId).toBe("Television_720p");
    expect(config["PlayStore.enabled"]).toBe("false");
  });

  test("keeps dotted keys intact", () => {
    const config = parseConfigIni("hw.lcd.density=213\nhw.lcd.width=1280");
    expect(config["hw.lcd.density"]).toBe("213");
    expect(config["hw.lcd.width"]).toBe("1280");
  });

  test("preserves empty values", () => {
    const config = parseConfigIni("fastboot.chosenSnapshotFile=");
    expect(config["fastboot.chosenSnapshotFile"]).toBe("");
  });

  test("splits on the first '=' only", () => {
    expect(parseConfigIni("key=a=b=c").key).toBe("a=b=c");
  });

  test("trims whitespace around keys and values", () => {
    expect(parseConfigIni("  hw.ramSize  =  2048  ")["hw.ramSize"]).toBe("2048");
  });

  test("ignores blank, comment and malformed lines", () => {
    const config = parseConfigIni("\n# comment\n; also comment\nnot-a-pair\nAvdId=x\n");
    expect(config).toEqual({ AvdId: "x" });
  });

  test("returns an empty object for empty input", () => {
    expect(parseConfigIni("")).toEqual({});
  });
});
