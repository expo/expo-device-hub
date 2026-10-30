import { describe, expect, test } from "bun:test";

import { FOLD_POSES } from "../fold";
import { DUO_POSE_ANGLES, hingeControlState, hingeWireCommand } from "../hinge-control";

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

test("face down preserves the hinge angle and elects the requested surface", () => {
  for (const value of [false, true]) {
    expect(hingeControlState({ control: "faceDown", value })).toEqual({
      hingePose: null,
      tableMode: value,
    });
  }
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
  expect(hingeWireCommand({ control: "faceDown", value: true })).toEqual({
    control: "physical",
    value: "facedown",
  });
  expect(hingeWireCommand({ control: "faceDown", value: false })).toEqual({
    control: "physical",
    value: "faceup",
  });
});
