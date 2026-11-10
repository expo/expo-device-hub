import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useReleaseFocusWhenHidden } from "../foldable/useReleaseFocusWhenHidden";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

function setup() {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const blurred: string[] = [];
  const focused = (name: string) => ({ name, blur: () => blurred.push(name) });
  const inside = focused("inside");
  const outside = focused("outside");
  const page = { activeElement: null as unknown };
  stubGlobal("document", page);
  const host = { current: { contains: (node: unknown) => node === inside } };
  function Harness({ hidden }: { hidden: boolean }) {
    useReleaseFocusWhenHidden(host as unknown as { current: HTMLElement }, hidden);
    return null;
  }
  const render = async (hidden: boolean) => {
    await act(async () => {
      if (renderer) renderer.update(<Harness hidden={hidden} />);
      else renderer = create(<Harness hidden={hidden} />);
    });
  };
  return { blurred, page, inside, outside, render };
}

test("a 3D preview that hides again gives up the keyboard focus", async () => {
  const { blurred, page, inside, render } = setup();
  page.activeElement = inside;
  await render(false);
  expect(blurred).toEqual([]);
  // A token change for the same device loads the preview again while it has focus.
  await render(true);
  expect(blurred).toEqual(["inside"]);
});

test("focus elsewhere on the page stays where it is", async () => {
  const { blurred, page, outside, render } = setup();
  page.activeElement = outside;
  await render(false);
  await render(true);
  expect(blurred).toEqual([]);
});
