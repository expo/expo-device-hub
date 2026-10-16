import { describe, expect, test } from "bun:test";
import { HINGE_POSES, isHingeControlCommand, isHingePreviewObserved, hingeControlState, isTableModeAvailable, observedHingePose } from "../hinge-control";

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

test("physical display handoff preserves the hinge angle and elects the requested surface", () => {
  for (const value of ["faceup", "facedown"] as const) {
    expect(isHingeControlCommand({ control: "physical", value })).toBe(true);
    expect(hingeControlState({ control: "physical", value })).toEqual({
      hingePose: null,
      tableMode: value === "facedown",
    });
  }
  for (const value of ["portrait", "other", 5, null]) {
    expect(isHingeControlCommand({ control: "physical", value })).toBe(false);
  }
});

test("observed native state names a preset only when all its fields are known and match", () => {
  expect(observedHingePose(0, "portrait", false)).toBe("closed");
  expect(observedHingePose(180, "portrait", false)).toBe("open");
  expect(observedHingePose(90, "landscape-left", false)).toBe("laptop");
  expect(observedHingePose(90, "portrait", false)).toBe("book");
  expect(observedHingePose(80, "facedown", true)).toBe("tent");
  expect(observedHingePose(89.5, "portrait", false)).toBe("book");
  expect(observedHingePose(80, "facedown", false)).toBeNull();
  expect(observedHingePose(90, "portrait", true)).toBeNull();
  expect(observedHingePose(80.6, "facedown", true)).toBeNull();
  expect(observedHingePose(45, "portrait", false)).toBeNull();
  expect(observedHingePose(90, "facedown", false)).toBeNull();
  expect(observedHingePose(0, "landscape-left", false)).toBeNull();
  expect(observedHingePose(undefined, "portrait", false)).toBeUndefined();
  expect(observedHingePose(90, undefined, false)).toBeUndefined();
  expect(observedHingePose(90, "portrait", undefined)).toBeUndefined();
});

test("a local preview is observed only when native state reaches each field it sets", () => {
  const tent = hingeControlState({ control: "pose", value: "tent" });
  const book = { hingeAngle: 90, hingePose: "book", physicalOrientation: "portrait", tableMode: false } as const;
  // The acknowledgement can arrive while native state still reports the previous pose.
  expect(isHingePreviewObserved(tent, book)).toBe(false);
  expect(isHingePreviewObserved(tent, { hingeAngle: 80.4, hingePose: null, tableMode: true })).toBe(false);
  expect(isHingePreviewObserved(tent, { hingeAngle: 80.4, hingePose: "tent", tableMode: false })).toBe(false);
  expect(isHingePreviewObserved(tent, { hingeAngle: 80.4, hingePose: "tent", physicalOrientation: "facedown", tableMode: true })).toBe(true);
  const angle = { tableMode: false, ...hingeControlState({ control: "angle", value: 120 }) };
  expect(isHingePreviewObserved(angle, { hingeAngle: 118.9, tableMode: false })).toBe(false);
  expect(isHingePreviewObserved(angle, { hingeAngle: 119.2, tableMode: false })).toBe(true);
  expect(isHingePreviewObserved(angle, { tableMode: false })).toBe(false);
  expect(isHingePreviewObserved({ hingeAngle: 90, ...hingeControlState({ control: "table", value: true }) }, { ...book, tableMode: true })).toBe(true);
  expect(isHingePreviewObserved({}, {})).toBe(true);
});

test("fractional native observations release a preset preview without a named-pose equality trap", () => {
  const closed = hingeControlState({ control: "pose", value: "closed" });
  expect(isHingePreviewObserved(closed, { hingeAngle: 180, physicalOrientation: "portrait", tableMode: false })).toBe(false);
  expect(isHingePreviewObserved(closed, { hingeAngle: 0.6, hingePose: null, physicalOrientation: "portrait", tableMode: false })).toBe(true);
  const laptop = hingeControlState({ control: "pose", value: "laptop" });
  expect(isHingePreviewObserved(laptop, { hingeAngle: 90, physicalOrientation: "portrait", tableMode: false })).toBe(false);
  expect(isHingePreviewObserved(laptop, { hingeAngle: 90.8, physicalOrientation: "landscape-left", tableMode: false })).toBe(true);
  expect(isHingePreviewObserved(laptop, { hingeAngle: 90.8, physicalOrientation: "landscape-left" })).toBe(false);
});
