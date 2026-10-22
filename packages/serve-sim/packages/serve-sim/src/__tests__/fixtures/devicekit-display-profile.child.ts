import { afterAll, expect, mock, test } from "bun:test";
import * as fs from "fs";
import * as childProcess from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const installedRoot = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes";
const root = fs.mkdtempSync(join(tmpdir(), "serve-sim-display-profiles-"));
const readdirSync = fs.readdirSync;
const profiles = [
  [
    "Single",
    [
      { displayType: "integrated", screenID: 7 },
      { displayType: "tvOut", screenID: 2 },
    ],
    [7],
  ],
  [
    "Duo",
    [
      { displayType: "integrated", screenID: 1 },
      { displayType: "integrated", screenID: 3 },
    ],
    [1, 3],
  ],
  ["External", [{ displayType: "tvOut" }], null],
  ["Empty", [], null],
  ["Malformed", [{ displayType: "integrated" }, {}], null],
  ["Missing", undefined, null],
  ["BadID", [{ displayType: "integrated", screenID: "1" }], null],
  [
    "Duplicate",
    [
      { displayType: "integrated", screenID: 1 },
      { displayType: "integrated", screenID: 1 },
    ],
    null,
  ],
] as const;

for (const [name, displays] of profiles) {
  const contents = join(root, `${name}.simdevicetype`, "Contents");
  fs.mkdirSync(join(contents, "Resources"), { recursive: true });
  fs.writeFileSync(
    join(contents, "Info.plist"),
    JSON.stringify({ CFBundleIdentifier: `fixture.${name}`, CFBundleName: name }),
  );
  if (displays !== undefined)
    fs.writeFileSync(
      join(contents, "Resources", "capabilities.plist"),
      JSON.stringify({ capabilities: { displays } }),
    );
}
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// Redirect the installed profile root and return JSON fixture contents at the
// plutil boundary. Keep the real identifier lookup, parsing, and display count.
mock.module("fs", () => ({
  ...fs,
  readdirSync: (path: string) => readdirSync(path === installedRoot ? root : path),
}));
mock.module("child_process", () => ({
  ...childProcess,
  execFileSync: (file: string, args: string[]) => {
    expect(file).toBe("plutil");
    expect(args.slice(0, 4)).toEqual(["-convert", "json", "-o", "-"]);
    const profilePath = args[4];
    if (!profilePath?.startsWith(`${installedRoot}/`)) throw new Error("Unexpected profile path");
    return fs.readFileSync(join(root, profilePath.slice(installedRoot.length)), "utf8");
  },
}));
const { integratedDisplayIds } = await import("../../devicekit-chrome");

for (const [name, , expected] of profiles) {
  test(`${name} integrated display IDs: ${expected}`, () => {
    expect(integratedDisplayIds(`fixture.${name}`)).toEqual(expected ? [...expected] : null);
  });
}
test("unknown and missing identifiers cannot permit fallback", () => {
  expect(integratedDisplayIds("fixture.unknown")).toBeNull();
  expect(integratedDisplayIds(undefined)).toBeNull();
});
