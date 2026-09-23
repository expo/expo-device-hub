import { describe, expect, test } from "bun:test";
import { resolveScreenConfigUpdate } from "../client/simulator/screen-config-state";

describe("screen config state", () => {
  test("adopts parent-provided config without echoing it back", () => {
    const update = resolveScreenConfigUpdate(
      null,
      { width: 1179, height: 2556, orientation: "portrait" },
      "external",
    );

    expect(update).toEqual({
      config: { width: 1179, height: 2556, orientation: "portrait" },
      notifyParent: false,
    });
  });

  test("notifies for sizes reported by the stream itself", () => {
    const update = resolveScreenConfigUpdate(
      null,
      { width: 1179, height: 2556, orientation: "portrait" },
      "reported",
    );

    expect(update?.notifyParent).toBe(true);
  });

  test("notifies for dimensions inferred from media", () => {
    expect(resolveScreenConfigUpdate(
      null,
      { width: 720, height: 1560 },
      "media",
    )?.notifyParent).toBe(true);
  });

  test("keeps prior orientation when image dimensions do not include one", () => {
    const update = resolveScreenConfigUpdate(
      { width: 2868, height: 1320, orientation: "landscape_left" },
      { width: 1320, height: 2868 },
      "reported",
    );

    expect(update).toEqual({
      config: { width: 1320, height: 2868, orientation: "landscape_left" },
      notifyParent: true,
    });
  });

  test("skips identical configs", () => {
    expect(
      resolveScreenConfigUpdate(
        { width: 1179, height: 2556, orientation: "portrait" },
        { width: 1179, height: 2556, orientation: "portrait" },
        "reported",
      ),
    ).toBeNull();
  });

  test("retains hinge state when decoded media reports only dimensions", () => {
    expect(resolveScreenConfigUpdate(
      { width: 2007, height: 2853, orientation: "landscape_left", hingeAngle: 0 },
      { width: 900, height: 1280 },
      "media",
    )?.config).toEqual({
      width: 900,
      height: 1280,
      orientation: "landscape_left",
      hingeAngle: 0,
    });
  });

  test("reports hinge movement even when screen geometry stays the same", () => {
    expect(resolveScreenConfigUpdate(
      { width: 2007, height: 2853, hingeAngle: 180 },
      { width: 2007, height: 2853, hingeAngle: 90 },
      "reported",
    )?.config.hingeAngle).toBe(90);
  });

  test("reports hinge capability before the initial angle is known", () => {
    expect(resolveScreenConfigUpdate(
      { width: 2007, height: 2853 },
      { width: 2007, height: 2853, supportsHingeAngle: true },
      "reported",
    )?.config.supportsHingeAngle).toBe(true);
  });

  test("reports a display switch even when both screens have the same dimensions", () => {
    expect(resolveScreenConfigUpdate(
      { width: 900, height: 1280, screenId: 1 },
      { width: 900, height: 1280, screenId: 3 },
      "external",
    )?.config.screenId).toBe(3);
    expect(resolveScreenConfigUpdate(
      { width: 900, height: 1280, screenId: 3 },
      { width: 450, height: 640 },
      "media",
    )?.config.screenId).toBe(3);
  });
});


test("preserves physical pose and table state through media updates, but accepts clearing a pose", () => {
  const current = { width: 900, height: 1280, hingeAngle: 90, hingePose: "laptop" as const, tableMode: false, tableModeAvailable: true };
  expect(resolveScreenConfigUpdate(current, { width: 450, height: 640 }, "media")?.config)
    .toMatchObject({ hingePose: "laptop", tableMode: false, tableModeAvailable: true });
  expect(resolveScreenConfigUpdate(current, { ...current, hingePose: "book" }, "external")?.config.hingePose).toBe("book");
  expect(resolveScreenConfigUpdate(current, { ...current, hingePose: null }, "external")?.config.hingePose).toBeNull();
  expect(resolveScreenConfigUpdate(current, { ...current, tableMode: true }, "external")?.config.tableMode).toBe(true);
  expect(resolveScreenConfigUpdate(current, { ...current, tableModeAvailable: false }, "external")?.config.tableModeAvailable).toBe(false);
});
