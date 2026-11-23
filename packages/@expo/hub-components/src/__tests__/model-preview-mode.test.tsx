import { afterEach, expect, test } from "bun:test";
import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type FoldPreviewMode } from "../dashboard/PhoneFrame";
import { useModelPreviewMode } from "../dashboard/useModelPreviewMode";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

type Preview = ReturnType<typeof useModelPreviewMode>;

/** A 3D model that fails as it mounts, as one does without WebGL: it reports from its own effect. */
function FailingModel({ onUnavailable }: { onUnavailable: () => void }) {
  useEffect(() => onUnavailable(), [onUnavailable]);
  return null;
}

async function mount(fails: (device: string) => boolean) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let preview!: Preview;
  function Harness({ device, chosen }: { device: string | null; chosen: FoldPreviewMode }) {
    preview = useModelPreviewMode(device, chosen);
    // As the dashboard does, the model mounts in the same commit that selects its device.
    return device && preview.mode === "3d" && fails(device) ? (
      <FailingModel key={device} onUnavailable={preview.reportUnavailable} />
    ) : null;
  }
  const render = async (device: string | null, chosen: FoldPreviewMode = "3d") => {
    await act(async () => {
      if (renderer) renderer.update(<Harness device={device} chosen={chosen} />);
      else renderer = create(<Harness device={device} chosen={chosen} />);
    });
    return preview;
  };
  return { render, preview: () => preview };
}

test("a model that fails as its device is selected leaves the dashboard in 2D", async () => {
  const { render, preview } = await mount((device) => device === "broken");
  expect((await render(null)).mode).toBe("3d");
  // The report comes from a child's effect in the commit that selects the device. A reset in this
  // hook's own effect ran after it and erased it, which left a failed model on screen.
  expect((await render("broken")).mode).toBe("2d");
  // It stays 2D, like a choice of 2D.
  expect((await render("broken")).mode).toBe("2d");
  // Another device tries its own model.
  expect((await render("fine")).mode).toBe("3d");
  // Back on the first device, the model is tried again, and fails again.
  expect((await render("broken")).mode).toBe("2d");
  expect(preview().mode).toBe("2d");
});

test("a new choice of 3D tries the model again", async () => {
  let fails = true;
  const { render, preview } = await mount(() => fails);
  expect((await render("one")).mode).toBe("2d");
  fails = false;
  await act(async () => preview().retry());
  expect(preview().mode).toBe("3d");
});

test("a choice of 2D shows 2D without a failure", async () => {
  const { render } = await mount(() => false);
  expect((await render("one", "2d")).mode).toBe("2d");
  expect((await render("one", "3d")).mode).toBe("3d");
});

test("a model that fails later, as on a lost WebGL context, also leaves 2D", async () => {
  const { render, preview } = await mount(() => false);
  expect((await render("one")).mode).toBe("3d");
  await act(async () => preview().reportUnavailable());
  expect(preview().mode).toBe("2d");
});
