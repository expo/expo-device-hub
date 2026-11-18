import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DEVICE_SHAPE_2D_ONLY_DESCRIPTION,
  DeviceOptionsSection,
  NO_DEVICE_SHAPE_DESCRIPTION,
} from "../dashboard/DeviceOptionsSection";
import { type FoldPreviewOption } from "../dashboard/FoldSettings";

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

function shapeSwitch(available: boolean, foldPreview?: FoldPreviewOption) {
  const html = renderToStaticMarkup(
    <DeviceOptionsSection
      screenShape={{ available, visible: true, onVisibleChange: () => {} }}
      foldPreview={foldPreview}
    />,
  );
  const tag = html.match(/<button[^>]*aria-label="Show device shape"[^>]*>/)?.[0] ?? "";
  return { html, tag };
}

test("disables the shape option in the 3D view, where the model draws its own device", () => {
  const { html, tag } = shapeSwitch(true, preview({ mode: "3d" }));
  expect(tag).toContain('disabled=""');
  // The viewer's choice stays, for the 2D view.
  expect(tag).toContain('aria-checked="true"');
  expect(html).toContain(DEVICE_SHAPE_2D_ONLY_DESCRIPTION);
});

test("enables the shape option in the 2D view, and when the 3D model could not load", () => {
  for (const foldPreview of [
    undefined,
    preview({ mode: "2d" }),
    preview({ mode: "3d", unavailable: true }),
  ]) {
    const { html, tag } = shapeSwitch(true, foldPreview);
    expect(tag).not.toContain("disabled");
    expect(html).not.toContain(DEVICE_SHAPE_2D_ONLY_DESCRIPTION);
  }
});

test("explains a missing shape before the 3D view", () => {
  const { html, tag } = shapeSwitch(false, preview({ mode: "3d" }));
  expect(tag).toContain('disabled=""');
  expect(tag).toContain('aria-checked="false"');
  expect(html).toContain(NO_DEVICE_SHAPE_DESCRIPTION);
  expect(html).not.toContain(DEVICE_SHAPE_2D_ONLY_DESCRIPTION);
});
