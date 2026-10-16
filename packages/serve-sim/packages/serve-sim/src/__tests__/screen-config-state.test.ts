import { describe, expect, test } from "bun:test";
import { previewScreenConfig, resolveScreenConfigUpdate } from "../client/simulator/screen-config-state";

describe("screen config state", () => {
  test("reports input availability changes without a screen geometry change", () => {
    const current = { width: 900, height: 1280, inputUnavailable: false };
    const failed = { ...current, inputUnavailable: true };
    expect(resolveScreenConfigUpdate(current, failed, "external")?.config.inputUnavailable).toBe(true);
    expect(resolveScreenConfigUpdate(failed, current, "external")?.config.inputUnavailable).toBe(false);
    expect(resolveScreenConfigUpdate(failed, { width: 450, height: 640 }, "media")?.config.inputUnavailable).toBe(true);
  });

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
      { width: 2007, height: 2853, orientation: "landscape_left", hingeAngle: 0, physicalOrientation: "portrait" },
      { width: 900, height: 1280 },
      "media",
    )?.config).toEqual({
      width: 900,
      height: 1280,
      orientation: "landscape_left",
      hingeAngle: 0,
      physicalOrientation: "portrait",
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

  test("reports physical orientation capability changes", () => {
    expect(resolveScreenConfigUpdate(
      { width: 2007, height: 2853, supportsHingeAngle: true },
      { width: 2007, height: 2853, supportsHingeAngle: true, supportsPhysicalOrientation: true },
      "reported",
    )?.config.supportsPhysicalOrientation).toBe(true);
  });

  test("reports a physical orientation change at the same hinge angle", () => {
    expect(resolveScreenConfigUpdate(
      { width: 2007, height: 2853, hingeAngle: 90, tableMode: true, physicalOrientation: "portrait" },
      { width: 2007, height: 2853, hingeAngle: 90, tableMode: true, physicalOrientation: "facedown" },
      "reported",
    )?.config.physicalOrientation).toBe("facedown");
  });

  test("clears physical orientation when the server no longer reports it", () => {
    const current = { width: 2007, height: 2853, hingeAngle: 90, physicalOrientation: "portrait" as const };
    const config = { width: 2007, height: 2853, hingeAngle: 90 };
    expect(resolveScreenConfigUpdate(current, config, "reported")?.config).not.toHaveProperty("physicalOrientation");
    expect(resolveScreenConfigUpdate(current, config, "external")?.config).not.toHaveProperty("physicalOrientation");
  });

  test("clears prior hinge state when a new server reports only screen geometry", () => {
    const current = {
      width: 2007, height: 2853, supportsHingeAngle: true, supportsPhysicalOrientation: true,
      hingeAngle: 90, hingePose: "book" as const, physicalOrientation: "portrait" as const,
      tableMode: true, tableModeAvailable: true,
      observedDeviceState: { hingeAngle: 80, physicalOrientation: "facedown" as const, tableMode: true },
    };
    const config = { width: 2007, height: 2853 };
    const legacy = { ...config, hingeAngle: 180, hingePose: "open" as const,
      physicalOrientation: "portrait" as const, tableMode: false };
    for (const source of ["reported", "external"] as const) {
      expect(resolveScreenConfigUpdate(current, config, source)?.config).toEqual(config);
      const updated = resolveScreenConfigUpdate(current, legacy, source)?.config;
      expect(updated).toEqual(legacy);
      expect(previewScreenConfig(updated!)).toEqual(legacy);
    }
    expect(resolveScreenConfigUpdate(current, { width: 900, height: 1280 }, "media")?.config)
      .toMatchObject({ hingePose: "book", tableMode: true, physicalOrientation: "portrait",
        observedDeviceState: current.observedDeviceState });
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


test("preview reads native pose independently of saved command state", () => {
  const command = { width: 2007, height: 2853, hingeAngle: 90, hingePose: "book" as const,
    physicalOrientation: "portrait" as const, tableMode: true, tableModeAvailable: true };
  const native = { hingeAngle: 90, physicalOrientation: "landscape-left" as const, tableMode: false };
  const raw = { ...command, observedDeviceState: native };
  expect(previewScreenConfig(raw)).toMatchObject({
    hingeAngle: 90, hingePose: "laptop", physicalOrientation: "landscape-left", tableMode: false,
  });
  expect(raw).toMatchObject(command);
  const unknown = previewScreenConfig({ ...raw, observedDeviceState: {} });
  expect(unknown.hingeAngle).toBeUndefined();
  expect(unknown.hingePose).toBeUndefined();
  expect(unknown.physicalOrientation).toBeUndefined();
  expect(unknown.tableMode).toBeUndefined();
  expect(unknown.tableModeAvailable).toBe(false);
});

test("native snapshot changes notify even when command state and geometry are unchanged", () => {
  const current = { width: 2007, height: 2853, hingeAngle: 90,
    observedDeviceState: { hingeAngle: 45, physicalOrientation: "portrait" as const, tableMode: false } };
  const updated = { ...current, observedDeviceState: { ...current.observedDeviceState, hingeAngle: 60 } };
  expect(resolveScreenConfigUpdate(current, updated, "reported")?.config).toEqual(updated);
  expect(resolveScreenConfigUpdate(current, { ...current, observedDeviceState: {} }, "reported")?.config.observedDeviceState).toEqual({});
  expect(resolveScreenConfigUpdate(current, { width: 900, height: 1280 }, "media")?.config.observedDeviceState)
    .toEqual(current.observedDeviceState);
});
