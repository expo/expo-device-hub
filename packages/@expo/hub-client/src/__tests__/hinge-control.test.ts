import { describe, expect, test } from "bun:test";

import { FOLD_POSES } from "../fold";
import {
  DUO_POSE_ANGLES,
  hingeControlState,
  hingeWireCommand,
  isHingePreviewObserved,
  observedHingePose,
} from "../hinge-control";

describe("Device Hub hinge controls", () => {
  test("keeps the five physical poses distinct, including the two 90 degree poses", () => {
    expect(FOLD_POSES.map((pose) => [pose, DUO_POSE_ANGLES[pose]])).toEqual([
      ["closed", 0],
      ["open", 180],
      ["laptop", 90],
      ["book", 90],
      ["tent", 80],
    ]);
    expect(hingeControlState({ control: "pose", value: "laptop" })).toEqual({
      hingeAngle: 90,
      hingePose: "laptop",
      tableMode: false,
    });
    expect(hingeControlState({ control: "pose", value: "book" })).toEqual({
      hingeAngle: 90,
      hingePose: "book",
      tableMode: false,
    });
  });

  test("manual angle changes clear the preset without assuming a physical orientation", () => {
    expect(hingeControlState({ control: "angle", value: 90 })).toEqual({
      hingeAngle: 90,
      hingePose: null,
      tableMode: false,
    });
  });
});

test("Table Mode clears the preset", () => {
  expect(hingeControlState({ control: "tableMode", value: true })).toEqual({
    tableMode: true,
    hingePose: null,
  });
});

test("maps fold commands to serve-sim's wire commands", () => {
  expect(hingeWireCommand({ control: "angle", value: 45.5 })).toEqual({
    control: "angle",
    value: 45.5,
  });
  expect(hingeWireCommand({ control: "pose", value: "tent" })).toEqual({
    control: "pose",
    value: "tent",
  });
  expect(hingeWireCommand({ control: "tableMode", value: true })).toEqual({
    control: "table",
    value: true,
  });
});

test("an observation that confirms a pose request also names that pose", () => {
  const laptop = hingeControlState({ control: "pose", value: "laptop" });
  const observed = {
    hingeAngle: 90.7,
    physicalOrientation: "landscape-left",
    tableMode: false,
  } as const;
  expect(isHingePreviewObserved(laptop, observed)).toBe(true);
  expect(observedHingePose(90.7, "landscape-left", false)).toBe("laptop");
  expect(observedHingePose(91.5, "landscape-left", false)).toBeNull();
});
