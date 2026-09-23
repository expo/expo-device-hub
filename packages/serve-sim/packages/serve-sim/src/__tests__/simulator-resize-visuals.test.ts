import { describe, expect, test } from "bun:test";
import {
  getPresentationFrameWidth,
  getSimulatorFrameMaxWidth,
  snapContainBox,
  RESIZE_MAIN_STROKE_W,
  restoredSimulatorFrameWidth,
  SIMULATOR_RESIZE_ABSOLUTE_MIN_WIDTH,
  SIMULATOR_RESIZE_HANDLE_DUR_HOT,
  SIMULATOR_RESIZE_HANDLE_DUR_IDLE,
  SIMULATOR_RESIZE_MAX_SCALE,
  SIMULATOR_RESIZE_MIN_WIDTH,
  SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME,
  SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_KEYBOARD,
  SIMULATOR_RESIZE_VIEWPORT_INSET_FOR_PRESENTATION,
  isVisualViewportKeyboardRaised,
} from "../client/utils/simulator-resize";

describe("simulator resize visual tuning", () => {
  test("uses a faint idle arc and faster highlight timing", () => {
    expect(RESIZE_MAIN_STROKE_W.idle).toBeLessThan(3);
    expect(SIMULATOR_RESIZE_HANDLE_DUR_HOT).toBe("0.16s");
    expect(SIMULATOR_RESIZE_HANDLE_DUR_IDLE).toBe("0.2s");
  });

  test("allows the frame to shrink below the preferred minimum in short viewports", () => {
    const maxWidth = getSimulatorFrameMaxWidth(320, 1280, 576, 1179 / 2556);

    expect(maxWidth).toBeLessThan(SIMULATOR_RESIZE_MIN_WIDTH);
    expect(maxWidth).toBeGreaterThanOrEqual(SIMULATOR_RESIZE_ABSOLUTE_MIN_WIDTH);
  });

  test("clamps restored scale to the current viewport on open", () => {
    const restored = restoredSimulatorFrameWidth(320, 1280, 576, 1179 / 2556, 3);
    const maxWidth = getSimulatorFrameMaxWidth(320, 1280, 576, 1179 / 2556);

    expect(restored).toBe(maxWidth);
  });

  test("falls back to the default frame width for invalid persisted scale", () => {
    expect(restoredSimulatorFrameWidth(320, 1280, 900, 1179 / 2556, Number.NaN)).toBe(320);
  });

  test("presentation fills the viewport instead of the chrome 3x cap", () => {
    const aspect = 1179 / 2556;
    const viewportWidth = 2000;
    const viewportHeight = 2400;
    const inset = SIMULATOR_RESIZE_VIEWPORT_INSET_FOR_PRESENTATION;
    const withChrome = getSimulatorFrameMaxWidth(320, viewportWidth, viewportHeight, aspect);
    const presentation = getPresentationFrameWidth(viewportWidth, viewportHeight, aspect);

    expect(withChrome).toBe(320 * SIMULATOR_RESIZE_MAX_SCALE);
    expect(presentation).toBeGreaterThan(withChrome);
    // Floored: rounding up overflows the viewport at full height.
    expect(presentation).toBe(Math.floor((viewportHeight - inset * 2) * aspect));
    expect(presentation / aspect).toBeLessThanOrEqual(viewportHeight - inset * 2);
  });

  test("presentation is width-capped on a short wide viewport", () => {
    const inset = SIMULATOR_RESIZE_VIEWPORT_INSET_FOR_PRESENTATION;
    const presentation = getPresentationFrameWidth(400, 2000, 1179 / 2556);
    expect(presentation).toBe(400 - inset * 2);
  });

  test("contain-fit boxes snap onto the device-pixel grid", () => {
    for (const dpr of [1, 2, 3]) {
      const box = snapContainBox(320.37, 693.21, 320, 693, dpr);

      expect(Number.isInteger(box.width * dpr)).toBe(true);
      expect(Number.isInteger(box.height * dpr)).toBe(true);
    }
  });

  test("reports a viewport-filling box only when both axes match", () => {
    expect(snapContainBox(320.4, 693.2, 320, 693, 1).fillsViewport).toBe(true);
    expect(snapContainBox(320.4, 693.2, 320, 693, 2).fillsViewport).toBe(false);

    const letterboxed = snapContainBox(300, 650, 320, 693, 2);
    expect(letterboxed.fillsViewport).toBe(false);
    expect(letterboxed.width).toBe(300);
    expect(letterboxed.height).toBe(650);
  });

  test("presentation width lands on the device-pixel grid at every ratio", () => {
    for (const dpr of [1, 2, 3]) {
      const width = getPresentationFrameWidth(1710, 1107, 1179 / 2556, undefined, dpr);

      expect(Number.isInteger(width * dpr)).toBe(true);
    }
  });

  test("a smaller height gutter raises the height-capped max width", () => {
    const aspect = 1179 / 2556;
    const viewportWidth = 390;
    const viewportHeight = 645;
    const withFullChrome = getSimulatorFrameMaxWidth(320, viewportWidth, viewportHeight, aspect);
    const withKeyboardChrome = getSimulatorFrameMaxWidth(
      320,
      viewportWidth,
      viewportHeight,
      aspect,
      SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_KEYBOARD,
    );

    expect(withKeyboardChrome).toBeGreaterThan(withFullChrome);
    expect(withFullChrome).toBe(
      getSimulatorFrameMaxWidth(
        320,
        viewportWidth,
        viewportHeight,
        aspect,
        SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME,
      ),
    );
    expect(withFullChrome).toBe((viewportHeight - SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME) * aspect);
    expect(withKeyboardChrome).toBe(
      (viewportHeight - SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_KEYBOARD) * aspect,
    );
  });

  test("keyboard height gutter fits the full frame in a short visual viewport", () => {
    const aspect = 1179 / 2556;
    const viewportHeight = 334;
    const maxWidth = getSimulatorFrameMaxWidth(
      320,
      390,
      viewportHeight,
      aspect,
      SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_KEYBOARD,
    );

    expect(maxWidth).toBe(
      (viewportHeight - SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_KEYBOARD) * aspect,
    );
    expect(maxWidth / aspect).toBeLessThanOrEqual(
      viewportHeight - SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_KEYBOARD,
    );
  });

  test("detects when the visual viewport shrank for the soft keyboard", () => {
    expect(isVisualViewportKeyboardRaised(645, 645)).toBe(false);
    expect(isVisualViewportKeyboardRaised(645, 520)).toBe(true);
    expect(isVisualViewportKeyboardRaised(0, 334)).toBe(false);
  });
});
