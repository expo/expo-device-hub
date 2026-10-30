import { expect, test } from "bun:test";
import { getSimulatorViewport } from "../client/utils/simulator-viewport";

test("centers in the area left by the right panel, even without a collision", () => {
  const area = getSimulatorViewport(1280, 0, 320);
  expect(area).toEqual({ left: 0, right: 332, width: 948 });
  expect(area.left + area.width / 2).toBe(474);
});

test("tracks panel resizing and accounts for both sides", () => {
  expect(getSimulatorViewport(1280, 0, 480)).toEqual({ left: 0, right: 492, width: 788 });
  expect(getSimulatorViewport(1440, 320, 320)).toEqual({ left: 320, right: 332, width: 788 });
  expect(getSimulatorViewport(1280, 0, 0)).toEqual({ left: 0, right: 0, width: 1280 });
});

test("keeps panels as overlays when no usable device area remains", () => {
  expect(getSimulatorViewport(390, 0, 320)).toEqual({ left: 0, right: 0, width: 390 });
  expect(getSimulatorViewport(700, 320, 320)).toEqual({ left: 0, right: 332, width: 368 });
  expect(getSimulatorViewport(800, 0, 720)).toEqual({ left: 0, right: 0, width: 800 });
});
