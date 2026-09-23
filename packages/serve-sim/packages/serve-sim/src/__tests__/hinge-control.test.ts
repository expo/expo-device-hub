import { describe, expect, test } from "bun:test";
import { HINGE_POSES, isHingeControlCommand, hingeControlState, isTableModeAvailable } from "../hinge-control";

describe("Device Hub hinge controls", () => {
  test("keeps the five physical poses distinct, including the two 90 degree poses", () => {
    expect(HINGE_POSES.map(({ id, angle }) => [id, angle])).toEqual([
      ["closed", 0], ["open", 180], ["laptop", 90], ["book", 90], ["tent", 80],
    ]);
    expect(hingeControlState({ control: "pose", value: "laptop" })).toEqual({ hingeAngle: 90, hingePose: "laptop", tableMode: false });
    expect(hingeControlState({ control: "pose", value: "book" })).toEqual({ hingeAngle: 90, hingePose: "book", tableMode: false });
  });

  test("manual angle changes clear the preset without assuming a physical orientation", () => {
    expect(hingeControlState({ control: "angle", value: 90 })).toEqual({ hingeAngle: 90, hingePose: null, tableMode: false });
  });

  test("accepts finite fine angles and known poses only", () => {
    for (const value of [0, 45.5, 90, 180]) expect(isHingeControlCommand({ control: "angle", value })).toBe(true);
    for (const { id } of HINGE_POSES) expect(isHingeControlCommand({ control: "pose", value: id })).toBe(true);
    for (const command of [null, [], {}, { control: "angle", value: "90" }, { control: "angle", value: NaN },
      { control: "angle", value: 181 }, { control: "angle", value: -1 }, { control: "pose", value: "half" },
      { control: "pose", value: 90 }, { control: "pitch", value: 0 }]) {
      expect(isHingeControlCommand(command)).toBe(false);
    }
  });
});


test("Table Mode follows physical pose eligibility", () => {
  expect(isTableModeAvailable(undefined, "portrait")).toBe(false);
  expect(isTableModeAvailable(90, undefined)).toBe(false);
  expect(isTableModeAvailable(0, "portrait")).toBe(false);
  expect(isTableModeAvailable(0, "landscape-left")).toBe(true);
  expect(isTableModeAvailable(180, "portrait")).toBe(true);
  expect(isTableModeAvailable(180, "landscape-left")).toBe(false);
  for (const orientation of ["portrait", "landscape-left", "facedown"] as const) {
    expect(isTableModeAvailable(90, orientation)).toBe(true);
  }
  expect(isTableModeAvailable(90, "faceup")).toBe(false);
  expect(hingeControlState({ control: "table", value: true })).toEqual({ tableMode: true, hingePose: null });
  expect(isHingeControlCommand({ control: "table", value: "true" })).toBe(false);
});
