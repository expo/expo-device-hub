import { describe, expect, test } from "bun:test";
import { type DeviceFold, type DeviceFoldCapabilities } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FoldSettings,
  type FoldPreviewOption,
  MODEL_UNAVAILABLE_DESCRIPTION,
} from "../dashboard/FoldSettings";
import { DUO_FOLD_CONTROLS } from "./duo-fixtures";

type FoldControls = Exclude<DeviceFoldCapabilities, false>;

/** What #352's Android emulator offers: the hinge angle and three poses. */
const ANDROID_FOLD_CONTROLS: FoldControls = {
  angle: { min: 0, max: 180 },
  poses: { closed: { angle: 0 }, book: { angle: 90 }, open: { angle: 180 } },
  tableMode: false,
  faceDown: false,
};

function fold(overrides: Partial<DeviceFold> = {}): DeviceFold {
  return {
    pending: false,
    error: null,
    tableMode: {},
    physical: { faceDown: false },
    setControl: () => {},
    ...overrides,
  };
}

function settings(
  overrides: Partial<DeviceFold> = {},
  preview?: FoldPreviewOption,
  controls: FoldControls = DUO_FOLD_CONTROLS,
) {
  return renderToStaticMarkup(
    <FoldSettings fold={fold(overrides)} controls={controls} preview={preview} />,
  );
}

function preview(overrides: Partial<FoldPreviewOption> = {}): FoldPreviewOption {
  return {
    mode: "3d",
    onModeChange: () => {},
    cacheScreenOnFold: false,
    onCacheScreenOnFoldChange: () => {},
    sizeMode: "fill",
    onSizeModeChange: () => {},
    ...overrides,
  };
}

function rowLabels(markup: string) {
  return [...markup.matchAll(/<span style="[^"]*font-weight:500[^"]*">([^<]+)<\/span>/g)].map(
    (match) => match[1],
  );
}

describe("FoldSettings", () => {
  test("shows only the controls that the device offers", () => {
    const android = settings(
      { angle: 90, pose: "book", tableMode: undefined, physical: undefined },
      undefined,
      ANDROID_FOLD_CONTROLS,
    );
    expect(rowLabels(android)).toEqual(["Fold pose", "Hinge angle"]);
    expect(android).toContain('data-test-options="Fully folded\nPartially open\nFully open"');
    // serve-emu on main only folds and unfolds fully.
    const postureOnly = settings({ angle: 0, pose: "closed" }, undefined, {
      ...ANDROID_FOLD_CONTROLS,
      angle: false,
      poses: { closed: { angle: 0 }, open: { angle: 180 } },
    });
    expect(rowLabels(postureOnly)).toEqual(["Fold pose"]);
    // A hinge that takes angles but no poses gets the slider alone.
    const angleOnly = settings({ angle: 120 }, undefined, { ...ANDROID_FOLD_CONTROLS, poses: {} });
    expect(rowLabels(angleOnly)).toEqual(["Hinge angle"]);
  });

  test("a pose that the device reports but does not offer shows as Custom", () => {
    const markup = settings({ angle: 80, pose: "tent" }, undefined, ANDROID_FOLD_CONTROLS);
    expect(markup).toContain(">Custom<");
  });

  test("the slider and the degree input follow the device's angle range", () => {
    const markup = settings({ angle: 270 }, undefined, {
      ...ANDROID_FOLD_CONTROLS,
      angle: { min: 180, max: 360 },
      poses: {},
    });
    const slider = markup.match(/<input[^>]*aria-label="Hinge angle"[^>]*>/)?.[0];
    expect(slider).toContain('min="180"');
    expect(slider).toContain('max="360"');
    const degrees = markup.match(/<input[^>]*aria-label="Hinge angle in degrees"[^>]*>/)?.[0];
    expect(degrees).toContain('min="180"');
    expect(degrees).toContain('max="360"');
  });

  test("lists the fold rows in serve-sim order with the model options while 3D is shown", () => {
    const markup = settings({}, preview());
    expect(rowLabels(markup)).toEqual([
      "Fold pose",
      "Hinge angle",
      "Table Mode",
      "Preview mode",
      "Cache screen on fold",
      "Preview size",
    ]);
    expect(markup).toContain('aria-label="Fold settings"');
    expect(markup).toContain(">Unknown<");
    expect(markup).toContain('aria-valuetext="Unknown"');
    expect(markup).toMatch(/type="number"[^>]*value=""/);
    expect(markup).toContain(">3D<");
    expect(markup).toContain(">Fill available space<");
  });

  test("2D keeps the native fold controls and hides options that only affect the model", () => {
    const markup = settings({}, preview({ mode: "2d" }));
    expect(rowLabels(markup)).toEqual(["Fold pose", "Hinge angle", "Table Mode", "Preview mode"]);
    expect(markup).toContain(">2D<");
  });

  test("omits the preview rows when the consumer offers no 3D model", () => {
    const markup = settings();
    expect(rowLabels(markup)).toEqual(["Fold pose", "Hinge angle", "Table Mode"]);
  });

  test("shows each named pose with serve-sim's labels and infers endpoints only without a reported pose", () => {
    for (const [pose, label] of [
      ["closed", "Fully folded"],
      ["book", "Partially open"],
      ["open", "Fully open"],
      ["laptop", "Laptop"],
      ["tent", "Tent"],
    ] as const) {
      const markup = settings({ angle: 90, pose });
      expect(markup).toContain(`>${label}<`);
      expect(markup).not.toContain(">Custom<");
    }
    expect(settings({ angle: 180 })).toContain(">Fully open<");
    expect(settings({ angle: 180, pose: null })).toContain(">Custom<");
    expect(settings({ angle: 42.5 })).toContain(">Custom<");
  });

  test("offers an accessible slider and a decimal degree input", () => {
    const markup = settings({ angle: 42.5 });
    const slider = markup.match(/<input[^>]*aria-label="Hinge angle"[^>]*>/)?.[0];
    expect(slider).toBeDefined();
    for (const attribute of ['type="range"', 'min="0"', 'max="180"', 'step="1"', 'value="42.5"']) {
      expect(slider).toContain(attribute);
    }
    expect(markup).toContain('aria-valuetext="42.5 degrees"');
    const degrees = markup.match(/<input[^>]*aria-label="Hinge angle in degrees"[^>]*>/)?.[0];
    expect(degrees).toBeDefined();
    for (const attribute of [
      'type="number"',
      'min="0"',
      'max="180"',
      'step="any"',
      'value="42.5"',
    ]) {
      expect(degrees).toContain(attribute);
    }
  });

  test("makes Table Mode available only when supported in the current pose, but always lets it turn off", () => {
    const unavailable = settings({ angle: 0 });
    expect(unavailable).toMatch(/role="switch"[^>]*aria-label="Table Mode"[^>]* disabled=""/);
    const available = settings({
      angle: 80,
      pose: "tent",
      tableMode: { enabled: true, available: true },
    });
    expect(available).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*aria-label="Table Mode"/);
    expect(available).not.toMatch(/role="switch"[^>]*aria-label="Table Mode"[^>]* disabled=""/);
    const stuckOn = settings({ tableMode: { enabled: true, available: false } });
    expect(stuckOn).not.toMatch(/role="switch"[^>]*aria-label="Table Mode"[^>]* disabled=""/);
    // The row is only its label and switch, with no description under it.
    for (const markup of [unavailable, available]) {
      expect(markup).not.toMatch(/aria-label="Table Mode"[^>]*aria-describedby/);
      expect(markup).not.toContain("rests on a table");
    }
    expect(unavailable).toContain(
      'aria-description="Table Mode is not available in the current pose."',
    );
    expect(available).not.toContain("Table Mode is not available in the current pose.");
  });

  test("keeps controls enabled while a change is pending and announces errors", () => {
    const pending = settings(
      { angle: 90, pose: "laptop", tableMode: { available: true }, pending: true },
      preview(),
    );
    expect(pending).toContain('aria-busy="true"');
    expect(pending).not.toMatch(/<(input|button)[^>]* disabled=""/);
    const failed = settings({ error: "Simulator could not change the device pose." });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Simulator could not change the device pose.");
  });

  test("explains an unavailable model next to the preview choice", () => {
    const markup = settings({}, preview({ unavailable: true }));
    expect(markup).toContain(MODEL_UNAVAILABLE_DESCRIPTION);
    expect(markup).toContain(">2D<");
  });
});
