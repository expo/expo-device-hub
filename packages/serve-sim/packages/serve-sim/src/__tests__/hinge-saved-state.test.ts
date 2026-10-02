import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { readSavedHingeState, writeSavedHingeState } from "../hinge-saved-state";
import { useTempStateDir, UDID } from "./helpers";

let tempState: ReturnType<typeof useTempStateDir>;

beforeAll(() => { tempState = useTempStateDir(); });
afterAll(() => { tempState.restore(); });

test("restores confirmed pose fields only at the native angle", () => {
  writeSavedHingeState(UDID, { hingeAngle: 90, physicalOrientation: "portrait", tableMode: false });
  expect(readSavedHingeState(UDID, 90)).toEqual({ physicalOrientation: "portrait", tableMode: false });
  expect(readSavedHingeState(UDID, 90.005)).toEqual({ physicalOrientation: "portrait", tableMode: false });
  expect(readSavedHingeState(UDID, 80)).toBeNull();
  expect(readSavedHingeState(UDID, undefined)).toBeNull();
  expect(readSavedHingeState("00000000-0000-0000-0000-000000000001", 90)).toBeNull();
});

test("invalidates saved pose when the angle is unknown", () => {
  writeSavedHingeState(UDID, { hingeAngle: 80, physicalOrientation: "facedown", tableMode: true });
  expect(readSavedHingeState(UDID, 80)).toEqual({ physicalOrientation: "facedown", tableMode: true });
  writeSavedHingeState(UDID, { physicalOrientation: undefined, tableMode: false });
  expect(readSavedHingeState(UDID, 80)).toBeNull();
});

test("preserves an explicitly cleared pose at the same angle", () => {
  writeSavedHingeState(UDID, { hingeAngle: 90, hingePose: "book", physicalOrientation: "portrait", tableMode: false });
  expect(readSavedHingeState(UDID, 90)?.hingePose).toBe("book");
  writeSavedHingeState(UDID, { hingeAngle: 90, hingePose: null, physicalOrientation: "portrait", tableMode: false });
  expect(readSavedHingeState(UDID, 90)).toEqual({ hingePose: null, physicalOrientation: "portrait", tableMode: false });
});

test("ignores corrupt saved state and keeps files private", () => {
  writeSavedHingeState(UDID, { hingeAngle: 90, physicalOrientation: "landscape-left", tableMode: false });
  const file = join(tempState.dir, `hinge-${UDID}.json`);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    hingeAngle: 90, physicalOrientation: "landscape-left", tableMode: false,
  });
  writeFileSync(file, JSON.stringify({ hingeAngle: 90, physicalOrientation: "diagonal", tableMode: true }));
  expect(readSavedHingeState(UDID, 90)).toBeNull();
});
