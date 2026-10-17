import { expect, test } from "bun:test";
import { createDuoRotationState } from "../client/simulator/duo-rotation-state";

test("native quarter turns include wraparound and do not depend on app geometry", () => {
  const state = createDuoRotationState();
  expect(state.observe("portrait", 0)).toBe(0);
  expect(state.observe("landscape-left", 1)).toBe(1);
  expect(state.observe("pud", 2)).toBe(1);
  expect(state.observe("landscape-right", 3)).toBe(1);
  expect(state.observe("portrait", 4)).toBe(1);
  expect(state.observe("landscape-right", 5)).toBe(-1);
});

test("UI rotation waits for readback without double turning, then follows external changes", () => {
  const state = createDuoRotationState();
  state.rebase("portrait");
  state.request(1, 0);
  expect(state.observe("portrait", 100)).toBe(0);
  expect(state.observe(undefined, 200)).toBe(0);
  expect(state.observe("landscape-left", 300)).toBe(0);
  expect(state.observe("pud", 400)).toBe(1);
});

test("unconfirmed UI rotation yields to native state after the readback grace period", () => {
  const state = createDuoRotationState();
  state.rebase("portrait");
  state.request(1, 0);
  expect(state.observe("portrait", 1499)).toBe(0);
  expect(state.observe("portrait", 1500)).toBe(-1);
});

test("preset and out of plane changes establish a new baseline", () => {
  const state = createDuoRotationState();
  state.rebase("portrait");
  state.request(1, 0);
  state.rebase("facedown");
  expect(state.observe("pud", 100)).toBe(0);
  state.rebase("landscape-left");
  expect(state.observe("pud", 200)).toBe(1);
});
