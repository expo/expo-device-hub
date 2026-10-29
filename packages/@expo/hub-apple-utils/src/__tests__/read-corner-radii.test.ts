import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCornerRadii, readCornerRadii } from "../read-corner-radii";

const display = (overrides: Record<string, unknown>) => ({
  displayType: "integrated",
  screenID: 1,
  width: 1206,
  height: 2622,
  scale: 3,
  cornerRadiusUL: 62,
  cornerRadiusUR: 62,
  cornerRadiusLR: 62,
  cornerRadiusLL: 62,
  ...overrides,
});

describe("parseCornerRadii", () => {
  test("divides point radii by the screen width in points", () => {
    const radii = parseCornerRadii({ capabilities: { displays: [display({})] } });

    // iPhone 17 Pro: 62 pt corners on a 402 pt wide screen.
    expect(radii?.topLeft).toBeCloseTo(62 / 402, 6);
    expect(radii?.bottomRight).toBeCloseTo(62 / 402, 6);
  });

  test("keeps iPhone Duo's small corners on the left", () => {
    const radii = parseCornerRadii({
      capabilities: {
        displays: [
          display({
            width: 1398,
            height: 2034,
            cornerRadiusUL: 8,
            cornerRadiusUR: 59,
            cornerRadiusLR: 59,
            cornerRadiusLL: 8,
          }),
          display({ screenID: 3, width: 2007, cornerRadiusUL: 55, cornerRadiusLL: 55 }),
        ],
      },
    });

    expect(radii?.topLeft).toBeCloseTo(8 / 466, 6);
    expect(radii?.bottomLeft).toBeCloseTo(8 / 466, 6);
    expect(radii?.topRight).toBeCloseTo(59 / 466, 6);
    expect(radii?.bottomRight).toBeCloseTo(59 / 466, 6);
  });

  test("keeps square corners at zero", () => {
    const radii = parseCornerRadii({
      capabilities: {
        displays: [
          display({ cornerRadiusUL: 0, cornerRadiusUR: 0, cornerRadiusLR: 0, cornerRadiusLL: 0 }),
        ],
      },
    });

    expect(radii).toEqual({ topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 });
  });

  test("skips displays that are not integrated or are incomplete", () => {
    expect(
      parseCornerRadii({
        capabilities: {
          displays: [
            display({ displayType: "tvOut" }),
            display({ cornerRadiusLL: undefined }),
            display({ scale: 0 }),
          ],
        },
      }),
    ).toBeNull();
  });

  test("returns null for unexpected payloads", () => {
    expect(parseCornerRadii(null)).toBeNull();
    expect(parseCornerRadii({ capabilities: {} })).toBeNull();
    expect(parseCornerRadii({ capabilities: { displays: "none" } })).toBeNull();
  });
});

const PREFIX = "com.apple.CoreSimulator.SimDeviceType.";

const xml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${body}</plist>`;

const infoPlist = (identifier: string) =>
  xml(`<dict><key>CFBundleIdentifier</key><string>${identifier}</string></dict>`);

const capabilitiesPlist = (radius: number) =>
  xml(`<dict><key>capabilities</key><dict><key>displays</key><array><dict>
    <key>displayType</key><string>integrated</string>
    <key>width</key><integer>1206</integer><key>scale</key><integer>3</integer>
    <key>cornerRadiusUL</key><integer>${radius}</integer><key>cornerRadiusUR</key><integer>${radius}</integer>
    <key>cornerRadiusLR</key><integer>${radius}</integer><key>cornerRadiusLL</key><integer>${radius}</integer>
  </dict></array></dict></dict>`);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A DeviceTypes folder of its own, because the reader keeps a scan per folder. */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hub-device-types-"));
  roots.push(root);
  return root;
}

function writeBundle(
  root: string,
  name: string,
  files: { info?: string; capabilities?: string },
): void {
  const contents = join(root, `${name}.simdevicetype`, "Contents");
  mkdirSync(join(contents, "Resources"), { recursive: true });
  if (files.info !== undefined) writeFileSync(join(contents, "Info.plist"), files.info);
  if (files.capabilities !== undefined) {
    writeFileSync(join(contents, "Resources", "capabilities.plist"), files.capabilities);
  }
}

describe("readCornerRadii", () => {
  test("returns null without a device type identifier", async () => {
    expect(await readCornerRadii(null)).toEqual({ value: null, error: null });
  });

  test("finds a bundle named after its identifier", async () => {
    const root = makeRoot();
    writeBundle(root, "iPhone Test", {
      info: infoPlist(`${PREFIX}iPhone-Test`),
      capabilities: capabilitiesPlist(60),
    });

    const read = await readCornerRadii(`${PREFIX}iPhone-Test`, root);

    expect(read.error).toBeNull();
    expect(read.value?.topLeft).toBeCloseTo(60 / 402, 6);
  });

  test("scans the bundles when the name differs from the identifier", async () => {
    const root = makeRoot();
    writeBundle(root, "iPad Pro (Test)", {
      info: infoPlist(`${PREFIX}iPad-Pro-Test`),
      capabilities: capabilitiesPlist(30),
    });

    const read = await readCornerRadii(`${PREFIX}iPad-Pro-Test`, root);

    expect(read.error).toBeNull();
    expect(read.value?.topLeft).toBeCloseTo(30 / 402, 6);
  });

  describe("no profile", () => {
    test("is a null value with no error for an unknown identifier", async () => {
      const root = makeRoot();
      writeBundle(root, "iPhone Test", { info: infoPlist(`${PREFIX}iPhone-Test`) });

      expect(await readCornerRadii(`${PREFIX}Nope`, root)).toEqual({ value: null, error: null });
    });

    test("is a null value with no error when there is no capabilities.plist", async () => {
      const root = makeRoot();
      writeBundle(root, "iPhone Test", { info: infoPlist(`${PREFIX}iPhone-Test`) });

      expect(await readCornerRadii(`${PREFIX}iPhone-Test`, root)).toEqual({
        value: null,
        error: null,
      });
    });

    test("is a null value with no error when the folder does not exist", async () => {
      expect(await readCornerRadii(`${PREFIX}iPhone-Test`, join(makeRoot(), "missing"))).toEqual({
        value: null,
        error: null,
      });
    });
  });

  describe("a failed read", () => {
    test("is an error when capabilities.plist cannot be read", async () => {
      const root = makeRoot();
      writeBundle(root, "iPhone Test", {
        info: infoPlist(`${PREFIX}iPhone-Test`),
        capabilities: "not a plist",
      });

      const read = await readCornerRadii(`${PREFIX}iPhone-Test`, root);

      expect(read.value).toBeNull();
      expect(read.error).not.toBeNull();
    });

    test("is an error, not a missing profile, when an Info.plist cannot be read", async () => {
      const root = makeRoot();
      writeBundle(root, "Broken", { info: "not a plist" });
      writeBundle(root, "iPad Pro (Test)", {
        info: infoPlist(`${PREFIX}iPad-Pro-Test`),
        capabilities: capabilitiesPlist(30),
      });

      // This model could be the broken bundle's, so it is not proven missing.
      const unknown = await readCornerRadii(`${PREFIX}Elsewhere`, root);
      expect(unknown.value).toBeNull();
      expect(unknown.error).not.toBeNull();

      // A model that another bundle declares is still found.
      const found = await readCornerRadii(`${PREFIX}iPad-Pro-Test`, root);
      expect(found.error).toBeNull();
      expect(found.value?.topLeft).toBeCloseTo(30 / 402, 6);
    });

    test("is not remembered: a scan that hit a failure is run again", async () => {
      const root = makeRoot();
      writeBundle(root, "Flaky", { info: "not a plist" });

      const first = await readCornerRadii(`${PREFIX}Flaky-Model`, root);
      expect(first.error).not.toBeNull();

      // The bundle becomes readable, as after a transient failure.
      writeBundle(root, "Flaky", {
        info: infoPlist(`${PREFIX}Flaky-Model`),
        capabilities: capabilitiesPlist(40),
      });
      const second = await readCornerRadii(`${PREFIX}Flaky-Model`, root);

      expect(second.error).toBeNull();
      expect(second.value?.topLeft).toBeCloseTo(40 / 402, 6);
    });
  });

  describe("parseCornerRadii with several displays", () => {
    test("uses the first integrated display, as documented", () => {
      const radii = parseCornerRadii({
        capabilities: {
          displays: [
            display({ screenID: 1, width: 1398, cornerRadiusUL: 8, cornerRadiusLL: 8 }),
            display({ screenID: 3, width: 2007, cornerRadiusUL: 55, cornerRadiusLL: 55 }),
          ],
        },
      });

      expect(radii?.topLeft).toBeCloseTo(8 / 466, 6);
    });
  });
});
