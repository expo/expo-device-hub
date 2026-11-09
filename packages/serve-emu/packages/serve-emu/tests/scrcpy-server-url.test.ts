import { describe, expect, test } from "bun:test";
import { SCRCPY_VERSION, scrcpyServerDownloadUrl } from "../src/scrcpy-server.ts";

const file = `v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;

describe("scrcpyServerDownloadUrl", () => {
  test("defaults to the GitHub release", () => {
    expect(scrcpyServerDownloadUrl("")).toBe(
      `https://github.com/Genymobile/scrcpy/releases/download/${file}`,
    );
  });

  test("uses the override base URL and trims trailing slashes", () => {
    expect(scrcpyServerDownloadUrl("https://mirror.example.com/scrcpy//")).toBe(
      `https://mirror.example.com/scrcpy/${file}`,
    );
  });
});
