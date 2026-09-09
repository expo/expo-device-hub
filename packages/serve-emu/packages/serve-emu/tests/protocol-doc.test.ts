import { describe, expect, test } from "bun:test";
import { SCRCPY_VERSION } from "../scripts/fetch-scrcpy.ts";
import {
  GOLDEN_SCRCPY_VERSION,
  PROTOCOL_GOLDEN_HEX,
  SCRCPY_VERSION_DOC_MARKER,
} from "./fixtures/protocol-golden.ts";

const PROTOCOL_DOC = Bun.file(
  new URL("../docs/protocol.md", import.meta.url),
);

describe("canonical protocol documentation", () => {
  test("the implementation, fixture, and docs marker pin one scrcpy version", async () => {
    expect(SCRCPY_VERSION).toBe(GOLDEN_SCRCPY_VERSION);
    expect(await PROTOCOL_DOC.exists()).toBe(true);
    const docs = await PROTOCOL_DOC.text();
    expect(docs).toContain(SCRCPY_VERSION_DOC_MARKER);
  });

  test("every parser golden is copied exactly into the protocol document", async () => {
    expect(await PROTOCOL_DOC.exists()).toBe(true);
    const docs = await PROTOCOL_DOC.text();
    for (const [name, value] of Object.entries(PROTOCOL_GOLDEN_HEX)) {
      expect(
        docs,
        `${name} golden is missing or mislabeled in docs/protocol.md`,
      ).toMatch(new RegExp(`^${name}:\\s+${value}$`, "m"));
    }
  });
});
